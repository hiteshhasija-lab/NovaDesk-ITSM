const { initDb, db } = require('./db');
const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const methodOverride = require('method-override');

const { attachUser } = require('./middleware/auth');
const helpers = require('./helpers');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const incidentRoutes = require('./routes/incidents');
const problemRoutes = require('./routes/problems');
const changeRoutes = require('./routes/changes');
const cmdbRoutes = require('./routes/cmdb');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const searchRoutes = require('./routes/search');
const profileRoutes = require('./routes/profile');
const myWorkRoutes = require('./routes/mywork');
const catalogRoutes = require('./routes/catalog');
const requestRoutes = require('./routes/requests');
const kbRoutes = require('./routes/kb');
const reportRoutes = require('./routes/reports');
const integrationRoutes = require('./routes/integrations');
const { startScheduler } = require('./scheduler');
const { reportMailSetup } = require('./mailer');
const { createLimiter } = require('./rateLimit');
const { sessionSecret } = require('./settings');

const app = express();
const PORT = process.env.PORT || 80;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const HOST = process.env.HOST || '0.0.0.0';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || path.join(__dirname, '..', 'certs', 'key.pem');
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(__dirname, '..', 'certs', 'cert.pem');

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: err.message });
  }
});

// Template helpers for every page, set before anything that can fail: an error raised by the body
// parser (a request that is too large) is rendered with the same layout, which needs `h`.
app.use((req, res, next) => {
  res.locals.h = helpers;
  res.locals.path = req.path;
  next();
});

// Basic browser hardening headers (set here because helmet is not a dependency of this app).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new FileStore({ path: path.join(__dirname, '..', 'data', 'sessions'), logFn: () => {} }),
  secret: sessionSecret(process.env),
  resave: false,
  saveUninitialized: false,
  // SameSite is explicit because the forms carry no CSRF tokens: a cross-site post must not carry the session.
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true, sameSite: 'lax' }
}));

app.use(attachUser);

// Sign-in: 20 refused attempts per address per 15 minutes. Sign-up: 20 requests per address per 15 minutes.
app.post('/login', createLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }));
app.post('/register', createLimiter({ windowMs: 15 * 60 * 1000, max: 20, countSuccess: true }));

app.use('/api/integrations', integrationRoutes);
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/incidents', incidentRoutes);
app.use('/problems', problemRoutes);
app.use('/changes', changeRoutes);
app.use('/cmdb', cmdbRoutes);
app.use('/users', userRoutes);
app.use('/notifications', notificationRoutes);
app.use('/search', searchRoutes);
app.use('/profile', profileRoutes);
app.use('/my-work', myWorkRoutes);
app.use('/catalog', catalogRoutes);
app.use('/requests', requestRoutes);
app.use('/kb', kbRoutes);
app.use('/reports', reportRoutes);

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
});

// A request the client got wrong is answered with its own 4xx status, not a 500 and a stack trace
// in the log: a body that is too large, malformed input, an id that is not a number.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode;
  // Postgres "invalid input syntax" / "out of range": a non-numeric or absurd id in the URL.
  if (err.code === '22P02' || err.code === '22003') return res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
  if (status >= 400 && status < 500) {
    const message = status === 413 ? 'That is too large to send.' : 'The request could not be read.';
    return res.status(status).render('error', { title: 'Request Refused', message });
  }
  console.error(err);
  res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong.' });
});

initDb()
  .then(() => {
    const servers = [];

    servers.push(app.listen(PORT, HOST, () => {
      console.log(`ITSM app running at http://${HOST}:${PORT}`);
      // The demo logins exist only when the demonstration workspace was asked for; never advertise them otherwise.
      if (process.env.SEED_DEMO === 'true') console.log('Demo logins (SEED_DEMO=true): admin/admin123 (admin), jdoe/agent123 (agent), mchen/user123 (end user)');
      reportMailSetup();
    }));

    if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
      const tlsOptions = {
        key: fs.readFileSync(TLS_KEY_PATH),
        cert: fs.readFileSync(TLS_CERT_PATH)
      };
      servers.push(https.createServer(tlsOptions, app).listen(HTTPS_PORT, HOST, () => {
        console.log(`ITSM app also running securely at https://${HOST}:${HTTPS_PORT}`);
      }));
    } else {
      console.log(`No TLS certificate found at ${TLS_CERT_PATH} — HTTPS not started.`);
    }

    startScheduler();

    // Running as PID 1 in a container: an unhandled SIGTERM is silently ignored rather
    // than terminating the process (the kernel's default signal disposition doesn't apply
    // to PID 1 without an explicit handler), which otherwise forces every container stop
    // to wait out the full timeout and fall back to SIGKILL.
    const shutdown = () => {
      console.log('Shutting down...');
      Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
