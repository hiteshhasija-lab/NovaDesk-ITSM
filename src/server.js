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

const app = express();
const PORT = process.env.PORT || 80;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const HOST = process.env.HOST || '0.0.0.0';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || path.join(__dirname, '..', 'certs', 'key.pem');
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(__dirname, '..', 'certs', 'cert.pem');

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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new FileStore({ path: path.join(__dirname, '..', 'data', 'sessions'), logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'itsm-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(attachUser);
app.use((req, res, next) => {
  res.locals.h = helpers;
  res.locals.path = req.path;
  next();
});

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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong.' });
});

initDb()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`ITSM app running at http://${HOST}:${PORT}`);
      console.log('Seed logins: admin/admin123 (admin), jdoe/agent123 (agent), mchen/user123 (end user)');
    });

    if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
      const tlsOptions = {
        key: fs.readFileSync(TLS_KEY_PATH),
        cert: fs.readFileSync(TLS_CERT_PATH)
      };
      https.createServer(tlsOptions, app).listen(HTTPS_PORT, HOST, () => {
        console.log(`ITSM app also running securely at https://${HOST}:${HTTPS_PORT}`);
      });
    } else {
      console.log(`No TLS certificate found at ${TLS_CERT_PATH} — HTTPS not started.`);
    }
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
