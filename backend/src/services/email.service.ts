import nodemailer from 'nodemailer';
import { env } from '../config/env';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    if (!env.EMAIL_USER || !env.EMAIL_PASS) {
      console.warn('⚠️  Email credentials not configured. Email sending is disabled.');
      // Create a test transport that logs instead of sending
      transporter = nodemailer.createTransport({
        jsonTransport: true,
      });
    } else {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASS,
        },
      });
    }
  }
  return transporter;
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${token}`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; background: #0a0a0f; color: #e2e8f0; margin: 0; padding: 40px 20px; }
        .container { max-width: 500px; margin: 0 auto; background: #12121a; border-radius: 16px; padding: 40px; border: 1px solid rgba(99, 102, 241, 0.2); }
        .logo { text-align: center; font-size: 28px; font-weight: 700; color: #818cf8; margin-bottom: 24px; }
        h1 { font-size: 20px; color: #e2e8f0; margin-bottom: 16px; }
        p { color: #94a3b8; line-height: 1.6; }
        .btn { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #6366f1, #818cf8); color: #fff; text-decoration: none; border-radius: 10px; font-weight: 600; margin: 24px 0; }
        .footer { font-size: 12px; color: #64748b; margin-top: 32px; text-align: center; }
        .code { background: #1e1e2e; padding: 12px 16px; border-radius: 8px; font-family: monospace; color: #818cf8; word-break: break-all; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">⚡ CI/CD Orchestrator</div>
        <h1>Password Reset Request</h1>
        <p>You requested a password reset. Click the button below to create a new password:</p>
        <div style="text-align: center;">
          <a href="${resetUrl}" class="btn">Reset Password</a>
        </div>
        <p>Or copy and paste this link into your browser:</p>
        <div class="code">${resetUrl}</div>
        <p>This link will expire in <strong>1 hour</strong>.</p>
        <p>If you did not request this reset, you can safely ignore this email.</p>
        <div class="footer">
          &copy; CI/CD Orchestrator — Automated Deployment Platform
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: `"CI/CD Orchestrator" <${env.EMAIL_USER || 'noreply@cicd.local'}>`,
    to,
    subject: '🔐 Password Reset — CI/CD Orchestrator',
    html: htmlContent,
  };

  const result = await getTransporter().sendMail(mailOptions);

  // If using JSON transport (no real SMTP), log the output
  if (!env.EMAIL_USER || !env.EMAIL_PASS) {
    console.log('📧 Email (dev mode - not actually sent):');
    console.log(`   To: ${to}`);
    console.log(`   Reset URL: ${resetUrl}`);
  } else {
    console.log(`📧 Password reset email sent to ${to}`);
  }
}
