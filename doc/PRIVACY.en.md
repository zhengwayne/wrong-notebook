# Privacy policy

[简体中文](PRIVACY.md) · Updated: November 25, 2026

## Scope and storage

wrong-notebook is self-hostable study software. Desktop editions run the server locally. The operator of each Docker, npm, fnOS or source deployment manages that instance's data. Android clients connect to the instance chosen by the user. Who can access data depends on the deployment and its operator.

An instance stores account information, password hashes, question text and images, answers, practice and exam records, and preferences needed for its features. Databases, uploaded files, server logs and configuration are stored in that instance's data or configuration directories; see the [installer guide](INSTALL_PACKAGES.md) for platform paths. Browser diagnostic logs may include page URLs, browser identifiers, errors and operation context and are sent to the same instance's server. They are not automatically sent to the project maintainer's servers.

AI API keys and endpoints, and credentials for a MiniMax Code account that the user chooses to connect, are stored in the instance configuration. MiniMax Code access and refresh tokens, account details and check-in results are stored in `minimax-code.json` in the configuration directory. Protect access to your instance, configuration and backups.

## Third-party services

- When signing in through the WeChat mini program, the instance exchanges the temporary `wx.login` code with WeChat for the openid under that mini program (the session_key is not stored), and keeps the openid-to-account binding plus a hash of the sign-in token. The first WeChat sign-in creates a WeChat-only account automatically: no phone number, email, avatar or nickname is collected; the account gets an undeliverable placeholder email (`@wechat.local`) that can never be used to sign in on the web, and a default display name (“微信用户” plus four characters) that the user can change. Users may optionally link the WeChat account to an existing web account; to delete a WeChat-only account, ask the instance administrator. Binding and tokens are removed on unbinding or account deletion. Photos taken or picked in the mini program are uploaded only to the connected instance.
- AI recognition, explanations, exercises and animations send the question content, images, answers or prompts needed for the task to the AI provider and endpoint configured by the administrator. Users and administrators choose whether to use these features and services.
- Cloud speech sends narration text to the configured speech provider. Browser speech uses browser-provided capabilities; processing depends on the browser and selected voice.
- After the user signs in to MiniMax Code, login, token refresh and AI requests connect to MiniMax. Automatic check-in also periodically sends authenticated check-in requests. Connecting an account is optional, and the user can sign out in Settings.
- Opening download, documentation, community or author links visits the corresponding websites. The website and packages are hosted by services including GitHub Pages and GitHub Releases, which process access requests under their own policies.
- When Windows SignPath signing is enabled, CI submits installer files and build provenance, not a running instance's user database, questions or credentials.

Request retention and processing are governed by the selected service's terms. Common policies include [Google](https://policies.google.com/privacy), [OpenAI](https://openai.com/policies/privacy-policy/), [Anthropic](https://www.anthropic.com/legal/privacy), [Microsoft](https://privacy.microsoft.com/privacystatement), and [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Consult the relevant provider for other AI channels and custom endpoints. [SignPath's privacy policy](https://about.signpath.io/privacy-policy) applies to signing applications and services.

## Data management and contact

Users can export personal data (including optional AES-256-GCM passphrase-encrypted v3 ZIP backups), delete individual items or study records, or permanently delete their account and all associated data under **Settings → Danger** after verifying their current password (removing notebooks, questions, practice records, learners, parent papers, grading data, learning paths, private speech caches, and historical learner backfill audits while emitting only one PII-free audit log; shared non-PII AI provenance entries and system tags are preserved). Instance administrators manage databases, logs and backups. Uninstalling a desktop app does not automatically delete its data directory; uninstalling standalone Android deletes its private data. Deleting instance data does not delete exported backups or requests already received by third parties; manage those separately with their respective operators.

In addition, **Settings → About** discloses to every signed-in user the active provider and endpoint locality (official cloud, local/LAN model endpoint, or custom remote) for vision, text, and voice narration. Uploaded images are re-encoded on the server to strip EXIF/GPS metadata before storage or upstream forwarding.

Do not enter personal study material into the shared demo. Contact your instance administrator for privacy requests about a self-hosted deployment. Contact the software maintainer through project [Issues](https://github.com/margrop/wrong-notebook/issues); use the [security reporting channel](../SECURITY.md) for sensitive account, credential or vulnerability information instead of posting it publicly.
