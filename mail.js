const nodemailer = require('nodemailer');
const devMode = !process.env.SMTP_HOST;
const tx = devMode ? null : nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: +(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
async function send({ to, bcc, subject, html }) {
  if (devMode) { console.log('[mail:dev]', subject, '->', to || `${(bcc || []).length} recipients`); return; }
  try { await tx.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, bcc, subject, html }); }
  catch (e) { console.error('Email failed:', e.message); }
}
const wrap = (title, body) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:16px"><h2 style="color:#10213a">Peak<span style="color:#f2a100">Foods</span></h2><h3>${title}</h3>${body}</div>`;
module.exports = { send, wrap, devMode };
