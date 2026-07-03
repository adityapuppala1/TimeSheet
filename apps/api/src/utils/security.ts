import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "../config/env.js";

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const opaqueToken = () => nanoid(48);
export const hashToken = (token: string) => bcrypt.hash(token, 10);
export const verifyTokenHash = (token: string, hash: string) => bcrypt.compare(token, hash);

export function signAccessToken(userId: string) {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, { subject: userId, expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"] });
}

export function signRefreshToken(userId: string, sessionId: string, days = env.REFRESH_TOKEN_TTL_DAYS) {
  return jwt.sign({ sid: sessionId }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    expiresIn: `${days}d`
  });
}
