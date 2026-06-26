// ============================================================================
// app.js — WebSocket Client Logic
// ============================================================================
//
// This file handles the browser side of our chat. It:
//   1. Shows the username modal and captures the user's name
//   2. Opens a WebSocket connection to our C++ server
//   3. Sends/receives JSON messages over that connection
//   4. Renders messages and the online user list in the DOM
//
// KEY CONCEPT: The WebSocket API
// --------------------------------
// The browser has a built-in WebSocket class. Usage:
//
//   const ws = new WebSocket("ws://localhost:8080/ws");
//   ws.onopen    = () => { ... }     // Connection established
//   ws.onmessage = (event) => { ... } // Server sent us data
//   ws.onclose   = () => { ... }     // Connection lost
//   ws.send("hello")                 // Send data to server
//
// That's it. Four events and one method. The rest is just UI code.
// ============================================================================

// ---- DOM Elements ----
const usernameModal  = document.getElementById('usernameModal');
const usernameForm   = document.getElementById('usernameForm');
const usernameInput  = document.getElementById('usernameInput');
const chatApp        = document.getElementById('chatApp');
const messagesDiv    = document.getElementById('messages');
const messageForm    = document.getElementById('messageForm');
const messageInput   = document.getElementById('messageInput');
const userList       = document.getElementById('userList');
const userCount      = document.getElementById('userCount');
const connectionStatus = document.getElementById('connectionStatus');
const badgeName      = document.getElementById('badgeName');
const badgeAvatar    = document.getElementById('badgeAvatar');

// ---- State ----
let ws = null;          // Our WebSocket connection
let myUsername = '';     // The name we chose

// ============================================================================
// COLOR ASSIGNMENT — Give each user a unique color
// ============================================================================
// We use a simple hash of the username to pick a color from a curated palette.
// This way, the same username always gets the same color, even across page loads.
// ============================================================================
const USER_COLORS = [
    '#00e5ff',  // cyan
    '#ff2d7b',  // magenta
    '#7c4dff',  // purple
    '#ffab40',  // amber
    '#69f0ae',  // green
    '#ff6e40',  // deep orange
    '#40c4ff',  // light blue
    '#ff4081',  // pink
    '#b388ff',  // light purple
    '#ffd740',  // yellow
];

function getUserColor(username) {
    // Simple hash: sum of char codes mod palette length
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
    }
    return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

// ============================================================================
// STEP 1: USERNAME FORM — Capture the user's name, then connect
// ============================================================================
usernameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myUsername = usernameInput.value.trim();
    if (!myUsername) return;

    // Update the header badge
    badgeName.textContent = myUsername;
    badgeAvatar.textContent = myUsername[0].toUpperCase();
    badgeAvatar.style.background = getUserColor(myUsername);

    // Hide modal, show chat
    usernameModal.classList.add('hidden');
    chatApp.style.display = 'grid';

    // Now connect the WebSocket
    connectWebSocket();

    // Focus the message input
    messageInput.focus();
});

// ============================================================================
// STEP 2: CONNECT THE WEBSOCKET
// ============================================================================
// We detect whether the page was loaded over HTTP or HTTPS and use the
// corresponding WebSocket protocol (ws:// or wss://).
//
// On Render, the page will be served over HTTPS, so we'll use wss://.
// Locally, it's HTTP, so we'll use ws://.
// ============================================================================
function connectWebSocket() {
    // Build the WebSocket URL from the current page location
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    ws = new WebSocket(wsUrl);

    // ---- Connection opened ----
    ws.onopen = () => {
        console.log('WebSocket connected to', wsUrl);
        setConnectionStatus(true);

        // STEP 3: Send our username as the first message
        // This is the "User Identification" step from the roadmap.
        ws.send(JSON.stringify({
            type: 'set_username',
            username: myUsername
        }));
    };

    // ---- Message received from server ----
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'message':
                renderMessage(data);
                break;
            case 'system':
                renderSystemMessage(data.text);
                break;
            case 'users':
                renderUserList(data.list);
                break;
            default:
                console.warn('Unknown message type:', data.type);
        }
    };

    // ---- Connection closed ----
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        setConnectionStatus(false);

        // Try to reconnect after 3 seconds
        setTimeout(() => {
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                console.log('Attempting reconnect...');
                connectWebSocket();
            }
        }, 3000);
    };

    // ---- Connection error ----
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// ============================================================================
// STEP 3: SEND A CHAT MESSAGE
// ============================================================================
messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    // Send the message to the server (which will broadcast it to everyone)
    ws.send(JSON.stringify({
        type: 'message',
        text: text
    }));

    messageInput.value = '';
    messageInput.focus();
});

// ============================================================================
// RENDERING FUNCTIONS — Turn JSON data into visible HTML
// ============================================================================

function renderMessage(data) {
    const isMe = data.username === myUsername;
    const color = getUserColor(data.username);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const msgEl = document.createElement('div');
    msgEl.className = `message ${isMe ? 'outgoing' : 'incoming'}`;

    msgEl.innerHTML = `
        <div class="message-header">
            <span class="message-username" style="color: ${color}">${escapeHtml(data.username)}</span>
            <span class="message-time">${time}</span>
        </div>
        <div class="message-text">${escapeHtml(data.text)}</div>
    `;

    messagesDiv.appendChild(msgEl);
    scrollToBottom();
}

function renderSystemMessage(text) {
    const msgEl = document.createElement('div');
    msgEl.className = 'message system';
    msgEl.innerHTML = `<div class="message-text">${escapeHtml(text)}</div>`;
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
}

function renderUserList(users) {
    userCount.textContent = users.length;
    userList.innerHTML = '';

    users.forEach(name => {
        const color = getUserColor(name);
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="user-avatar" style="background: ${color}">${name[0].toUpperCase()}</span>
            <span>${escapeHtml(name)}${name === myUsername ? ' (you)' : ''}</span>
        `;
        userList.appendChild(li);
    });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function setConnectionStatus(connected) {
    if (connected) {
        connectionStatus.classList.remove('disconnected');
        connectionStatus.querySelector('.status-text').textContent = 'Connected';
    } else {
        connectionStatus.classList.add('disconnected');
        connectionStatus.querySelector('.status-text').textContent = 'Reconnecting...';
    }
}

function scrollToBottom() {
    const panel = document.querySelector('.messages-panel');
    // Use requestAnimationFrame to ensure DOM has updated before scrolling
    requestAnimationFrame(() => {
        panel.scrollTop = panel.scrollHeight;
    });
}

// Prevent XSS: escape HTML characters in user input before rendering
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
