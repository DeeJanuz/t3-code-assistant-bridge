# Contributor instructions

Enable GronkSpeak for this directory and its descendants, following the shared style policy in the global AGENTS.md.

Read README.md before changing setup or user-facing behavior. Preserve existing user changes. Never commit credentials, signing keys, personalized packages, local configuration, or private hostnames.

Run `npm run check:all` after runtime changes. Keep the bridge on loopback, preserve scoped authentication, and keep rejecting browser `Origin` headers outside the loopback Signal setup page. Installer changes must preserve existing T3 data and service configuration.
