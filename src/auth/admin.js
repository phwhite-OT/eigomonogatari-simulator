export const ADMIN_EMAILS = Object.freeze([
  "justdoittakama1029@gmail.com",
]);

export function normalizeAdminEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isAdministratorEmail(value) {
  return ADMIN_EMAILS.includes(normalizeAdminEmail(value));
}

export function isAdministratorSession(session) {
  return isAdministratorEmail(session?.user?.email);
}
