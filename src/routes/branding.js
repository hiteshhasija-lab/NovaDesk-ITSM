// Branding, for the administrator: the product name, logo, accent colour and sign-in wording (src/branding.js).
// The form is multipart (it can carry the logo), so the request-forgery check happens here, once the fields have been read.
const multer = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { audit } = require('../audit');
const csrf = require('../csrf');
const branding = require('../branding');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

// A little more than the largest picture allowed, so a too-large one reaches the check that explains it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: branding.LIMITS.backgroundBytes + 1024, files: 2, fields: 14, fieldSize: 4096 } })
  .fields([{ name: 'logo', maxCount: 1 }, { name: 'background', maxCount: 1 }]);
const bufferOf = (req, name) => { const f = req.files && req.files[name] && req.files[name][0]; return f && f.size ? f.buffer : null; };

async function view(extra = {}) {
  return { title: 'Branding', limits: branding.LIMITS, defaults: branding.DEFAULTS, error: null, notice: null, form: null, ...extra };
}

router.get('/', async (req, res) => {
  const notice = req.session.brandingNotice || null;
  delete req.session.brandingNotice;
  res.render('branding/index', await view({ notice }));
});

router.post('/', (req, res) => {
  upload(req, res, async (err) => {
    try {
      if (!csrf.checkRequest(req)) return csrf.refuse(req, res);
      const again = async (error) => res.status(400).render('branding/index', await view({ error, form: req.body }));
      if (err) return again(err.code === 'LIMIT_FILE_SIZE' ? `That picture is too large. A logo can be up to ${branding.LIMITS.logoBytes / 1024} KB and a sign-in background up to ${branding.LIMITS.backgroundBytes / 1048576} MB.` : 'The form could not be read. Try again.');
      let values;
      try { values = branding.validate(req.body, { logo: bufferOf(req, 'logo'), background: bufferOf(req, 'background') }, { hadBackground: Boolean((await branding.get()).backgroundUrl) }); } catch (e) {
        if (e instanceof branding.BrandingError) return again(e.message);
        throw e;
      }
      const detail = await branding.save(values, req.session.user);
      await audit(req, req.session.user, 'branding.changed', { targetType: 'branding', detail });
      req.session.brandingNotice = detail === 'saved without changes' ? 'Nothing changed.' : 'Saved. Every page already uses the new look; emails sent from now on do too.';
      res.redirect('/settings/branding');
    } catch (e) {
      console.error(`[Branding] ${e.stack || e}`);
      res.status(500).render('error', { title: 'Branding was not saved', message: 'Something went wrong while saving. Nothing was changed.' });
    }
  });
});

router.post('/reset', async (req, res) => {
  await branding.reset(req.session.user);
  await audit(req, req.session.user, 'branding.reset', { targetType: 'branding', detail: 'name, logo, colour, sign-in background and wording put back to the built-in look' });
  req.session.brandingNotice = 'Branding was put back to the built-in NovaDesk look.';
  res.redirect('/settings/branding');
});

module.exports = router;
