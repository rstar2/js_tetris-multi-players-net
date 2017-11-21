const WebSocketServer = require('ws').Server;

const Client = require('./client');
const Session = require('./session');
const generateId = require('./guid').generateId;
const log = require('./debug').log;

const server = new WebSocketServer({ port: 9000 });

const MSG_TYPE = {
    SESSION_CREATE: 'session-create',
    SESSION_CREATED: 'session-created',
    SESSION_JOIN: 'session-join',
    SESSION_STATE: 'session-state',
    SESSION_DESTROYED: 'session-destroyed',

    UPDATE_STATE: 'update-state',
};

const sessions = new Map();

server.on('connection', conn => {
    const client = createClient(conn);

    conn.on('close', () => {
        log('Client disconnected', client.id);

        const session = client.session;
        if (session) {
            session.leave(client);

            if (client.isCreator) {
                log('Session creator has disconnected', client.id);
                // notify all remaining clients
                broadcastSessionDestroy(session);

                // destroy current session and clear clients (they will close their connections also)
                session.clients.forEach(client => client.close());
            }

            if (session.isEmpty) {
                log('Session destroyed', session.id);
                sessions.delete(session.id);
            }

            // broadcast the current room's/session's state
            broadcastSessionState(session);
        }
    });

    conn.on('message', event => {
        const { type, data } = JSON.parse(event);
        log('Message received', type, data);

        // handle special messages first
        switch (type) {
            case MSG_TYPE.SESSION_CREATE:
                onSessionCreate(client);
                break;
            case MSG_TYPE.SESSION_JOIN:
                onSessionJoin(client, data.id);
                break;
            case MSG_TYPE.UPDATE_STATE:
                onUpdateState(client, data);
                break;
        }

    });
});

/**
 * @param {WebSocket} conn
 * @param {String} id
 * @returns {Client}
 */
function createClient(conn, id = generateId()) {
    const client = new Client(conn, id);
    log('Client connected', client.id);

    return client;
}

/**
 * 
 * @param {String} id
 * @returns {Session}
 */
function createSession(id = generateId()) {
    if (getSession(id)) {
        throw new Error(`Session with id ${id} already exists.`);
    }

    const session = new Session(id);
    sessions.set(session.id, session);
    log('Session created ', session.id);

    return session;
}

/**
 * @param {String} id
 * @returns {Session|null} 
 */
function getSession(id) {
    return sessions.get(id);
}

/**
 * 
 * @param {Client} client 
 * @param {String} type 
 * @param {Object} [data] 
 */
function broadcastMessage(client, type, data) {
    if (!client.isAttachedTo()) {
        throw new Error(`Client ${client} is not in a session in order to broadcast messages`);
    }
    const session = client.session;
    session.clients.filter(aClient => aClient !== client).
        forEach(aClient => {
            aClient.send(type, {
                state: data,
                peer: client.id
            });
        });
}

/**
 * 
 * @param {Session} session 
 */
function broadcastSessionState(session) {
    const clients = session.clients;
    const clientCreator = clients.find(client => client.isCreator);

    // if the client created the session is missing (e.g. disconnected)
    // the the session is in "disconnecting" state - disconnecting all its clients
    // so no need to send any state event
    if (!clientCreator) {
        return;
    }

    clients.forEach(client => {
        client.send(MSG_TYPE.SESSION_STATE, {
            current: client.id,
            creator: clientCreator.id,
            peers: clients.map(client => client.id)
        });
    });
}

/**
 * 
 * @param {Session} session 
 */
function broadcastSessionDestroy(session) {
    session.clients.forEach(client => client.send(MSG_TYPE.SESSION_DESTROYED));
}


/**
 * 
 * @param {Client} client 
 */
function onSessionCreate(client) {
    const session = createSession();
    session.join(client, true);
    client.send(MSG_TYPE.SESSION_CREATED, { id: session.id });
}

/**
 * 
 * @param {Client} client 
 */
function onSessionJoin(client, sessionId) {
    let createdNow = false;
    let session = getSession(sessionId);
    if (!session) {
        session = createSession(sessionId);
        createdNow = true;
    }
    session.join(client, createdNow);
    log('Session joined', session.id, session.size);

    // broadcast the current room's/session's state
    broadcastSessionState(session);
}

/**
 * 
 * @param {Client} client 
 * @param {Object} state 
 */
function onUpdateState(client, state) {
    log('Update state for client', client.id);

    // convert the "ended" boolean to a common for all server-time
    if (state.ended) {
        state.ended = new Date().getTime();

        // TODO: also send such event to the ended client
        client.send(MSG_TYPE.UPDATE_STATE, { ended: state.ended });
    }

    // broadcast the current client's state to all other clients of the session
    broadcastMessage(client, MSG_TYPE.UPDATE_STATE, state);
}
