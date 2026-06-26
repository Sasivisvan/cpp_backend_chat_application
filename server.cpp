// ============================================================================
// server.cpp — A WebSocket Chat Server from Scratch
// ============================================================================
//
// HOW THIS FILE IS ORGANIZED (following the 4-step roadmap):
//
//   1. ECHO SERVER     — Accept a connection, echo messages back
//   2. MULTICASTING    — Broadcast messages to ALL connected clients
//   3. USER ID         — First message sets your username
//   4. SERVE FRONTEND  — Serve HTML/CSS/JS so browsers can connect
//
// Each section builds on the last. Read top to bottom.
// ============================================================================

#include <crow.h>           // Crow: our web framework (HTTP + WebSocket)
#include <fstream>          // For reading files from disk
#include <mutex>            // For thread safety (multiple clients = multiple threads)
#include <sstream>          // For reading file contents into strings
#include <string>
#include <unordered_map>    // Hash map: connection → username
#include <unordered_set>    // Hash set: all active connections

// ============================================================================
// GLOBAL STATE — The Shared Brain of Our Server
// ============================================================================
//
// Why global? Because Crow's WebSocket callbacks (onopen, onmessage, onclose)
// are separate functions. They all need access to the same list of connections.
//
// Why a mutex? Crow runs in multiple threads. If two clients connect at the
// exact same moment, two threads might try to modify the set simultaneously.
// A mutex is a lock — only one thread can hold it at a time.
// ============================================================================

std::mutex mtx;  // The lock that guards our shared data

// Every connected WebSocket client gets a crow::websocket::connection pointer.
// We store them in a set so we can iterate over "all clients."
std::unordered_set<crow::websocket::connection*> clients;

// Maps each connection to a username string.
// When a user first connects, they don't have a name yet — it's empty.
std::unordered_map<crow::websocket::connection*, std::string> usernames;

// ============================================================================
// HELPER: Read a file from the "static/" directory
// ============================================================================
// This is how our C++ server acts as a web server — it reads HTML/CSS/JS
// files from disk and sends them to the browser, just like Nginx or Apache.
// ============================================================================
std::string readStaticFile(const std::string& filename) {
    std::ifstream file("static/" + filename);
    if (!file.is_open()) return "";
    std::stringstream buffer;
    buffer << file.rdbuf();  // Read entire file into the stringstream
    return buffer.str();
}

// ============================================================================
// HELPER: Broadcast a message to ALL connected clients
// ============================================================================
// This is Step 2 (Multicasting) in action.
//
// We iterate through every connection in our set and send the message.
// The caller must already hold the mutex (that's what the comment says).
// ============================================================================
void broadcast(const std::string& message) {
    // mtx must be locked by the caller before calling this!
    for (auto* client : clients) {
        client->send_text(message);
    }
}

// ============================================================================
// HELPER: Build a JSON string for the list of online users
// ============================================================================
// We manually build JSON here to avoid adding a JSON library dependency.
// Format: {"type":"users","list":["Alice","Bob"]}
// ============================================================================
std::string buildUserListJson() {
    std::string json = R"({"type":"users","list":[)";
    bool first = true;
    for (auto& [conn, name] : usernames) {
        if (name.empty()) continue;  // Skip users who haven't set a name yet
        if (!first) json += ",";
        json += "\"" + name + "\"";
        first = false;
    }
    json += "]}";
    return json;
}

// ============================================================================
// MAIN — Where everything comes together
// ============================================================================
int main() {
    crow::SimpleApp app;

    // ========================================================================
    // STEP 4: SERVE THE FRONTEND
    // ========================================================================
    // These are plain HTTP routes. When a browser visits http://localhost:8080/,
    // Crow reads index.html from disk and sends it back.
    //
    // This is identical to what Nginx does when you visit a website.
    // The browser then requests style.css and app.js as <link> and <script>.
    // ========================================================================

    CROW_ROUTE(app, "/")
    ([](const crow::request&, crow::response& res) {
        std::string content = readStaticFile("index.html");
        if (content.empty()) {
            res.code = 404;
            res.write("File not found");
        } else {
            res.set_header("Content-Type", "text/html");
            res.write(content);
        }
        res.end();
    });

    CROW_ROUTE(app, "/style.css")
    ([](const crow::request&, crow::response& res) {
        std::string content = readStaticFile("style.css");
        res.set_header("Content-Type", "text/css");
        res.write(content);
        res.end();
    });

    CROW_ROUTE(app, "/app.js")
    ([](const crow::request&, crow::response& res) {
        std::string content = readStaticFile("app.js");
        res.set_header("Content-Type", "application/javascript");
        res.write(content);
        res.end();
    });

    // ========================================================================
    // STEPS 1-3: THE WEBSOCKET ENDPOINT
    // ========================================================================
    //
    // HTTP is "request → response." The client asks, the server answers, done.
    // WebSocket is different: it's a persistent, two-way pipe. Either side can
    // send a message at any time. Perfect for real-time chat.
    //
    // The browser connects to ws://localhost:8080/ws and the connection stays
    // open. Crow gives us three callbacks:
    //
    //   onopen    — A new client just connected
    //   onmessage — A client sent us some data
    //   onclose   — A client disconnected
    //
    // ========================================================================

    CROW_WEBSOCKET_ROUTE(app, "/ws")

    // --------------------------------------------------------------------
    // STEP 1: ON OPEN — A new client connected
    // --------------------------------------------------------------------
    // This is the most basic part of a WebSocket server: acknowledging
    // that someone connected. We store their connection pointer so we
    // can send them messages later.
    // --------------------------------------------------------------------
    .onopen([](crow::websocket::connection& conn) {
        std::lock_guard<std::mutex> lock(mtx);  // Lock the mutex (auto-unlocks)
        clients.insert(&conn);                   // Add to our set of clients
        usernames[&conn] = "";                   // No username yet
        CROW_LOG_INFO << "New connection. Total clients: " << clients.size();
    })

    // --------------------------------------------------------------------
    // STEP 2 + 3: ON MESSAGE — A client sent us data
    // --------------------------------------------------------------------
    // This is where the magic happens. We receive raw text from a client.
    //
    // STEP 1 (Echo):      We'd just do conn.send_text(data) to echo it back.
    // STEP 2 (Multicast): Instead of echoing to one, we broadcast to all.
    // STEP 3 (Username):  We check if the message is setting a username
    //                     or sending a chat message.
    //
    // Our protocol (the "language" clients and server speak):
    //
    //   Client → Server:
    //     {"type":"set_username", "username":"Alice"}   — I want to be "Alice"
    //     {"type":"message", "text":"Hello everyone!"}  — Send this to everyone
    //
    //   Server → All Clients:
    //     {"type":"message", "username":"Alice", "text":"Hello everyone!"}
    //     {"type":"system", "text":"Alice joined the chat"}
    //     {"type":"users", "list":["Alice","Bob"]}
    //
    // We parse JSON manually here (Crow has crow::json but let's keep it
    // simple with string searching — this is a learning project).
    // --------------------------------------------------------------------
    .onmessage([](crow::websocket::connection& conn, const std::string& data, bool /*is_binary*/) {
        std::lock_guard<std::mutex> lock(mtx);

        // --- Simple JSON field extraction ---
        // Find a value like: "key":"value" in the JSON string.
        // This is fragile but works for our simple protocol.
        auto getField = [&](const std::string& json, const std::string& key) -> std::string {
            std::string search = "\"" + key + "\":\"";
            size_t start = json.find(search);
            if (start == std::string::npos) return "";
            start += search.size();
            size_t end = json.find("\"", start);
            if (end == std::string::npos) return "";
            return json.substr(start, end - start);
        };

        std::string type = getField(data, "type");

        // ---- STEP 3: Handle "set_username" ----
        if (type == "set_username") {
            std::string name = getField(data, "username");
            if (name.empty()) return;

            usernames[&conn] = name;
            CROW_LOG_INFO << "User set name: " << name;

            // Tell everyone that a new user joined
            std::string joinMsg = R"({"type":"system","text":")" + name + R"( joined the chat"})";
            broadcast(joinMsg);

            // Send updated user list to everyone
            broadcast(buildUserListJson());
        }

        // ---- STEP 2: Handle "message" — broadcast to all ----
        else if (type == "message") {
            std::string text = getField(data, "text");
            std::string username = usernames[&conn];
            if (username.empty()) username = "Anonymous";
            if (text.empty()) return;

            // Build the outgoing message JSON
            std::string outMsg = R"({"type":"message","username":")" + username +
                                 R"(","text":")" + text + R"("})";

            // STEP 1 would be:  conn.send_text(outMsg);  (echo to sender only)
            // STEP 2 is:        broadcast(outMsg);        (send to everyone)
            broadcast(outMsg);
        }
    })

    // --------------------------------------------------------------------
    // ON CLOSE — A client disconnected
    // --------------------------------------------------------------------
    // Clean up: remove them from our set and tell everyone they left.
    // --------------------------------------------------------------------
    .onclose([](crow::websocket::connection& conn, const std::string& /*reason*/) {
        std::lock_guard<std::mutex> lock(mtx);

        std::string name = usernames[&conn];
        clients.erase(&conn);
        usernames.erase(&conn);

        CROW_LOG_INFO << "Connection closed. Total clients: " << clients.size();

        // If they had a username, announce their departure
        if (!name.empty()) {
            std::string leaveMsg = R"({"type":"system","text":")" + name + R"( left the chat"})";
            broadcast(leaveMsg);
            broadcast(buildUserListJson());
        }
    });

    // ========================================================================
    // START THE SERVER
    // ========================================================================
    // Render (our deployment platform) tells us which port to use via the
    // PORT environment variable. Locally, we default to 8080.
    //
    // .bindaddr("0.0.0.0") means "listen on all network interfaces" —
    // required for Docker/Render (otherwise it only listens on localhost).
    //
    // .multithreaded() uses multiple CPU cores to handle concurrent clients.
    // ========================================================================
    int port = 8080;
    if (const char* envPort = std::getenv("PORT")) {
        port = std::atoi(envPort);
    }

    CROW_LOG_INFO << "Chat server starting on port " << port;
    app.bindaddr("0.0.0.0").port(port).multithreaded().run();

    return 0;
}
