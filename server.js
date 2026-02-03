const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, '/'))); // Serve root for bingo.html
app.use('/public', express.static(path.join(__dirname, 'public'))); // Serve public folder

// Game State
let gameState = {
    players: {}, // id -> { id, name, card, marks, socket, joinedAt }
    calledNumbers: [],
    status: 'waiting', // waiting, playing
    hostSocket: null
};

// --- Helper Functions ---

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function generateBingoCard() {
    const card = [[], [], [], [], []]; // 5 Columns
    const usedNumbers = new Set();

    // Generate pool of numbers 1-50
    const pool = Array.from({ length: 50 }, (_, i) => i + 1);

    // Fisher-Yates shuffle
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    // Fill columns
    let count = 0;
    for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 5; row++) {
            card[col][row] = pool[count++];
        }
    }

    // Set FREE space
    card[2][2] = 'FREE';
    return card;
}

function checkBingo(card, marks) {
    // Convert 2D array card to checkable structure if needed, or just iterate properties
    // Card is [Col0, Col1, Col2, Col3, Col4]
    // marks is Set of numbers

    const isMarked = (r, c) => {
        if (r === 2 && c === 2) return true; // FREE space
        const num = card[c][r];
        return marks.includes(num);
    };

    // Check Columns
    for (let c = 0; c < 5; c++) {
        if ([0, 1, 2, 3, 4].every(r => isMarked(r, c))) return true;
    }

    // Check Rows
    for (let r = 0; r < 5; r++) {
        if ([0, 1, 2, 3, 4].every(c => isMarked(r, c))) return true;
    }

    // Check Diagonals
    if ([0, 1, 2, 3, 4].every(i => isMarked(i, i))) return true;
    if ([0, 1, 2, 3, 4].every(i => isMarked(i, 4 - i))) return true;

    return false;
}

function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    // Broadcast to mechanics
    if (gameState.hostSocket && gameState.hostSocket.readyState === WebSocket.OPEN) {
        gameState.hostSocket.send(message);
    }

    Object.values(gameState.players).forEach(player => {
        if (player.socket && player.socket.readyState === WebSocket.OPEN) {
            player.socket.send(message);
        }
    });
}

function broadcastToHost(type, payload) {
    if (gameState.hostSocket && gameState.hostSocket.readyState === WebSocket.OPEN) {
        gameState.hostSocket.send(JSON.stringify({ type, payload }));
    }
}

// --- Routes ---

app.get('/qr', async (req, res) => {
    // Use the host header which works for both Local and Cloud
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const url = `${protocol}://${host}/public/player.html`;

    try {
        const qr = await QRCode.toDataURL(url);
        res.json({ url, qr });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR' });
    }
});

// --- WebSocket ---

wss.on('connection', (ws) => {
    let playerId = null;
    let isHost = false;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'host_connect':
                    isHost = true;
                    gameState.hostSocket = ws;
                    // Send initial state to host
                    ws.send(JSON.stringify({
                        type: 'init_host',
                        payload: {
                            players: Object.values(gameState.players).map(p => ({
                                id: p.id,
                                name: p.name,
                                bingoCount: 0 // Track wins if needed
                            })),
                            calledNumbers: gameState.calledNumbers
                        }
                    }));
                    console.log('Host connected');
                    break;

                case 'player_join':
                    const name = data.payload.name || 'Anonymous';
                    playerId = uuidv4();
                    const card = generateBingoCard();

                    gameState.players[playerId] = {
                        id: playerId,
                        name: name,
                        card: card,
                        marks: [], // Track marked numbers locally in server logic if we want strict validation
                        socket: ws,
                        joinedAt: Date.now()
                    };

                    // Send init data to player
                    ws.send(JSON.stringify({
                        type: 'game_joined',
                        payload: {
                            id: playerId,
                            card: card,
                            calledNumbers: gameState.calledNumbers
                        }
                    }));

                    // Notify host
                    broadcastToHost('player_joined', { id: playerId, name: name });
                    console.log(`Player ${name} (${playerId}) joined`);
                    break;

                case 'host_draw_number':
                    if (!isHost) return;
                    const number = data.payload.number;
                    if (!gameState.calledNumbers.includes(number)) {
                        gameState.calledNumbers.push(number);
                        broadcast('number_called', { number });
                    }
                    break;

                case 'host_reset_game':
                    if (!isHost) return;
                    gameState.calledNumbers = [];
                    // Generate new cards for all existing players
                    Object.keys(gameState.players).forEach(pid => {
                        const newCard = generateBingoCard();
                        gameState.players[pid].card = newCard;
                        gameState.players[pid].marks = [];

                        // Send new card to player
                        if (gameState.players[pid].socket.readyState === WebSocket.OPEN) {
                            gameState.players[pid].socket.send(JSON.stringify({
                                type: 'game_reset_new_card',
                                payload: { card: newCard }
                            }));
                        }
                    });
                    broadcastToHost('game_reset_confirmed', {});
                    break;

                case 'player_claim_bingo':
                    if (isHost || !playerId) return;
                    const player = gameState.players[playerId];
                    const playerMarks = data.payload.marks || []; // Marks sent from client

                    // Basic validation: user marks must be in calledNumbers
                    const validMarks = playerMarks.filter(m => gameState.calledNumbers.includes(m));

                    if (checkBingo(player.card, validMarks)) {
                        broadcast('player_won', { name: player.name });
                        // Optionally record win in player object
                    } else {
                        // False alarm
                        ws.send(JSON.stringify({ type: 'bingo_rejected', payload: { reason: 'card_not_valid' } }));
                    }
                    break;
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        if (isHost) {
            gameState.hostSocket = null;
            console.log('Host disconnected');
        } else if (playerId) {
            delete gameState.players[playerId];
            broadcastToHost('player_left', { id: playerId });
            console.log(`Player ${playerId} left`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Local IP for LAN: ${getLocalIP()}`);
});
