import bcrypt from 'bcrypt';
import createHttpError from 'http-errors';
import jwt from 'jsonwebtoken';
import handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';

import { Session } from '../models/session.js';
import { User } from '../models/user.js';
import { createSession, setSessionCookies } from '../services/auth.js';
import { sendEmail } from '../utils/sendMail.js';

const JWT_SECRET = process.env.JWT_SECRET;

const getResetPasswordTemplate = async () => {
  const templatePath = new URL(
    '../templates/reset-password-email.html',
    import.meta.url,
  );
  const template = await readFile(templatePath, 'utf-8');
  return handlebars.compile(template);
};

export const registerUser = async (req, res) => {
  const { email, password } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw createHttpError(400, 'Email in use');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await User.create({
    email,
    password: hashedPassword,
  });

  const session = await createSession(user._id);
  setSessionCookies(res, session);

  res.status(201).json(user);
};

export const loginUser = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    throw createHttpError(401, 'Invalid credentials');
  }

  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    throw createHttpError(401, 'Invalid credentials');
  }

  await Session.deleteMany({ userId: user._id });

  const session = await createSession(user._id);
  setSessionCookies(res, session);

  res.status(200).json(user);
};

export const refreshUserSession = async (req, res) => {
  const { sessionId, refreshToken } = req.cookies;

  let session;
  try {
    session = await Session.findOne({
      _id: sessionId,
      refreshToken,
    });
  } catch (error) {
    if (error.name === 'CastError') {
      throw createHttpError(401, 'Session not found');
    }
    throw error;
  }

  if (!session) {
    throw createHttpError(401, 'Session not found');
  }

  if (new Date() > session.refreshTokenValidUntil) {
    await Session.deleteOne({ _id: session._id });

    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    };

    res.clearCookie('sessionId', cookieOptions);
    res.clearCookie('accessToken', cookieOptions);
    res.clearCookie('refreshToken', cookieOptions);

    throw createHttpError(401, 'Session token expired');
  }

  await Session.deleteOne({ _id: session._id });

  const newSession = await createSession(session.userId);
  setSessionCookies(res, newSession);

  res.status(200).json({
    message: 'Session refreshed',
  });
};

export const logoutUser = async (req, res) => {
  const { sessionId } = req.cookies;

  if (sessionId) {
    try {
      await Session.deleteOne({ _id: sessionId });
    } catch (error) {
      if (error.name !== 'CastError') {
        throw error;
      }
    }
  }

  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
  };

  res.clearCookie('sessionId', cookieOptions);
  res.clearCookie('accessToken', cookieOptions);
  res.clearCookie('refreshToken', cookieOptions);

  res.status(204).send();
};

export const requestResetEmail = async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    throw createHttpError(404, 'User not found');
  }

  if (!JWT_SECRET) {
    throw createHttpError(500, 'JWT secret is not configured');
  }

  const token = jwt.sign({ userId: user._id.toString(), email }, JWT_SECRET, {
    expiresIn: '5m',
  });

  const resetUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:3000'}/reset-password?token=${encodeURIComponent(token)}`;

  const template = await getResetPasswordTemplate();
  const html = template({
    name: user.username ?? user.email,
    link: resetUrl,
  });

  await sendEmail({
    to: user.email,
    subject: 'Reset your password',
    html,
  });

  res.status(200).json({
    message: 'Reset password email sent',
  });
};

export const resetPassword = async (req, res) => {
  const { token, password } = req.body;

  if (!JWT_SECRET) {
    throw createHttpError(500, 'JWT secret is not configured');
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw createHttpError(401, 'Invalid or expired reset token');
  }

  const user = await User.findOne({
    _id: payload.userId,
    email: payload.email,
  });

  if (!user) {
    throw createHttpError(404, 'User not found');
  }

  user.password = await bcrypt.hash(password, 10);
  await user.save();

  await Session.deleteMany({ userId: user._id });

  res.status(200).json({
    message: 'Password has been reset successfully',
  });
};
