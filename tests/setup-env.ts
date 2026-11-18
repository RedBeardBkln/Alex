import { randomBytes } from "node:crypto";

export const TEST_KEY = randomBytes(32).toString("base64");

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://unused",
  APP_URL: "https://alex.example.com/",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret",
  ALEX_ALLOWED_EMAILS: " Owner@Example.com , second@example.com",
  ALEX_ENCRYPTION_KEY: TEST_KEY,
  GOOGLE_OAUTH_TESTING_MODE: "true",
});
