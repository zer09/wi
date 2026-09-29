import { createClient } from './client.js';
import { mountView, parseSessionHash, sessionHash, supportedOrigin } from './view.js';
const root = document.getElementById('app');
if (root !== null) {
    const client = createClient();
    const view = mountView(root, client, sid => {
        const hash = sessionHash(sid);
        if (window.location.hash === hash)
            readHash();
        else
            window.location.hash = hash;
    }, supportedOrigin(window.location.protocol, window.location.hostname));
    function readHash() {
        const route = parseSessionHash(window.location.hash);
        view.route(route);
        const state = client.snapshot();
        if (state.connection === 'connected' && route.kind === 'session' && state.selected?.session_id !== route.session_id) {
            void client.selectSession(route.session_id);
        }
    }
    let connected = false;
    client.subscribe(state => {
        view.render(state);
        const justConnected = !connected && state.connection === 'connected';
        connected = state.connection === 'connected';
        // Reopening a fragment only reads. Neither navigation nor connection submits work.
        if (justConnected)
            readHash();
    });
    window.addEventListener('hashchange', readHash);
    // Local disposal also covers the back/forward cache. It never calls run cancellation.
    window.addEventListener('pagehide', () => client.disconnect());
    window.addEventListener('beforeunload', () => client.disconnect());
    readHash();
}
