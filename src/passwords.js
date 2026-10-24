// Passwords: what is acceptable, and hashing and checking them without blocking the server.
'use strict';
const bcrypt = require('bcryptjs');
const { securitySettings } = require('./settings');

const COST = 10;
// bcrypt only reads the first 72 bytes: a longer password would be silently cut, so it is refused instead.
const MAX_BYTES = 72;

// Passwords that are guessed first. Compared in lower case, with trailing digits and punctuation taken off, so
// "Password1!" counts as "password".
const COMMON = new Set(`password passw0rd p4ssword letmein welcome qwerty qwertyuiop azerty asdfgh asdfghjkl zxcvbn zxcvbnm iloveyou monkey dragon
  master sunshine princess football baseball soccer hockey batman superman trustno1 whatever starwars freedom shadow michael jennifer jordan
  harley ranger hunter buster thomas robert daniel andrew matthew joshua charlie summer winter spring autumn secret login admin administrator
  root toor user guest test testing demo changeme change-me default temp temporary access mustang liverpool arsenal chelsea cheese ginger
  pepper abc abcdef abcdefg abcd1234 abc123 qazwsx 1qaz2wsx 1q2w3e 1q2w3e4r 111111 123123 123321 654321 666666 7777777 12345 123456 1234567
  12345678 123456789 1234567890 0987654321 password1 password123 admin123 admin1234 welcome1 welcome123 letmein1 qwerty123 itsm itsm123 novadesk
  novadesk1 novadesk123 helpdesk helpdesk1 servicedesk company company1 corporate network server cisco vmware windows linux microsoft`.split(/\s+/).filter(Boolean));

const minLength = (env = process.env) => securitySettings(env).passwordMinLength;

// null when acceptable, otherwise a sentence saying what to change. `who` is { username, email, fullName } to keep a
// password from being the person's own name.
function checkPassword(password, who = {}, env = process.env) {
  const pw = String(password === undefined || password === null ? '' : password);
  const min = minLength(env);
  if (pw.length < min) return `The password must be at least ${min} characters long.`;
  if (Buffer.byteLength(pw) > MAX_BYTES) return `The password is too long: at most ${MAX_BYTES} characters (the hashing method reads no more).`;
  if (/^(.)\1*$/.test(pw)) return 'The password cannot be one character repeated.';
  const plain = pw.toLowerCase().replace(/[\d\W_]+$/, '');
  if (COMMON.has(pw.toLowerCase()) || COMMON.has(plain)) return 'That password is one of the first ones attackers try. Choose something longer and less predictable, such as a few unrelated words.';
  const lower = pw.toLowerCase();
  for (const part of [who.username, (who.email || '').split('@')[0], ...String(who.fullName || '').split(/\s+/)]) {
    if (part && part.length >= 4 && lower.includes(String(part).toLowerCase())) return 'The password cannot contain your name, username or email.';
  }
  return null;
}

const hashPassword = (password) => bcrypt.hash(password, COST);
const verifyPassword = (password, hash) => bcrypt.compare(String(password || ''), hash);

// Compared against when there is no such person, so an unknown username takes as long to refuse as a wrong password
// (otherwise the response time says which usernames exist).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-just-for-timing', COST);
const verifyAgainstNobody = (password) => bcrypt.compare(String(password || ''), DUMMY_HASH);

module.exports = { checkPassword, hashPassword, verifyPassword, verifyAgainstNobody, minLength, COST, MAX_BYTES };
