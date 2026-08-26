// Route fixtures below model an owner-only hosting layer that strips incoming
// identity headers and injects the authenticated owner ID.
process.env.LEDGERLENS_TRUST_PLATFORM_AUTH = "true";
