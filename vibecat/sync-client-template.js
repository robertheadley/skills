/**
 * VibeCat 2 compatibility notice.
 *
 * Do not paste a synchronization client into a userscript. VibeCat now injects
 * its authenticated, project-scoped browser bridge into development output at
 * delivery time. The source userscript remains free of tokens, sockets, DOM
 * reporting, console interception, and reload behavior.
 *
 * Start the supported workflow with:
 *   vibecat bootstrap --project "<absolute-project-path>" --plan --json
 *
 * This file intentionally performs no browser action. It remains only so old
 * links and automation fail safely instead of restoring the removed client.
 */
'use strict';
