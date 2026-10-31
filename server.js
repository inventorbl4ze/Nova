
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20
});

const chatLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20
});

// DATABASE SETUP
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(30) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(100) DEFAULT 'New chat',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id)
        ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL
        CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS conversations_user_idx
    ON conversations(user_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS messages_chat_idx
    ON messages(conversation_id, id);
  `);
}

// AUTHENTICATION
function createToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Please sign in again." });
  }
}

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({ status: "online", app: "NOVA AI" });
});

// REGISTER
app.post("/api/auth/register", authLimit, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (username.length < 2 || username.length > 30) {
      return res.status(400).json({
        error: "Username must be 2–30 characters."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Enter a valid email."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users(username,email,password_hash)
       VALUES($1,$2,$3)
       RETURNING id,username,email`,
      [username, email, hash]
    );

    const user = result.rows[0];

    res.status(201).json({
      token: createToken(user),
      user
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "This email is already registered."
      });
    }

    console.error(error);
    res.status(500).json({
      error: "Account creation failed."
    });
  }
});

// LOGIN
app.post("/api/auth/login", authLimit, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(
      password,
      user.password_hash
    ))) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    res.json({
      token: createToken(user),
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed." });
  }
});

// CURRENT USER
app.get("/api/me", authenticate, async (req, res) => {
  const result = await pool.query(
    "SELECT id,username,email,created_at FROM users WHERE id=$1",
    [req.user.id]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "User not found." });
  }

  res.json({ user: result.rows[0] });
});

// GET CONVERSATIONS
app.get("/api/conversations", authenticate, async (req, res) => {
  const result = await pool.query(
    `SELECT id,title,created_at,updated_at
     FROM conversations
     WHERE user_id=$1
     ORDER BY updated_at DESC`,
    [req.user.id]
  );

  res.json({ conversations: result.rows });
});

// CREATE CONVERSATION
app.post("/api/conversations", authenticate, async (req, res) => {
  const title = String(req.body.title || "New chat")
    .trim()
    .slice(0, 100);

  const result = await pool.query(
    `INSERT INTO conversations(user_id,title)
     VALUES($1,$2)
     RETURNING id,title,created_at,updated_at`,
    [req.user.id, title || "New chat"]
  );

  res.status(201).json({
    conversation: result.rows[0]
  });
});

// CHECK CONVERSATION OWNERSHIP
async function getOwnedConversation(id, userId) {
  const result = await pool.query(
    "SELECT id,title FROM conversations WHERE id=$1 AND user_id=$2",
    [id, userId]
  );

  return result.rows[0];
}

// GET MESSAGES
app.get(
  "/api/conversations/:id/messages",
  authenticate,
  async (req, res) => {
    const conversation = await getOwnedConversation(
      req.params.id,
      req.user.id
    );

    if (!conversation) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    const result = await pool.query(
      `SELECT id,role,content,created_at
       FROM messages
       WHERE conversation_id=$1
       ORDER BY id`,
      [conversation.id]
    );

    res.json({
      conversation,
      messages: result.rows
    });
  }
);

// RENAME CONVERSATION
app.patch(
  "/api/conversations/:id",
  authenticate,
  async (req, res) => {
    const title = String(req.body.title || "")
      .trim()
      .slice(0, 100);

    if (!title) {
      return res.status(400).json({
        error: "Enter a conversation title."
      });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET title=$1,updated_at=NOW()
       WHERE id=$2 AND user_id=$3
       RETURNING id,title`,
      [title, req.params.id, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    res.json({ conversation: result.rows[0] });
  }
);

// DELETE CONVERSATION
app.delete(
  "/api/conversations/:id",
  authenticate,
  async (req, res) => {
    const result = await pool.query(
      "DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    res.json({ success: true });
  }
);

// AI CHAT
app.post("/api/chat", authenticate, chatLimit, async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const conversationId = req.body.conversationId;

    if (!message || message.length > 6000) {
      return res.status(400).json({
        error: "Message must contain 1–6000 characters."
      });
    }

    const baseUrl = process.env.AI_BASE_URL;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL;

    if (!baseUrl || !apiKey || !model) {
      return res.status(503).json({
        error: "NOVA AI is not connected to its AI provider yet."
      });
    }

    let conversation;

    if (conversationId) {
      conversation = await getOwnedConversation(
        conversationId,
        req.user.id
      );

      if (!conversation) {
        return res.status(404).json({
          error: "Conversation not found."
        });
      }
    } else {
      const created = await pool.query(
        `INSERT INTO conversations(user_id,title)
         VALUES($1,$2)
         RETURNING id,title`,
        [req.user.id, message.slice(0, 42)]
      );

      conversation = created.rows[0];
    }

    await pool.query(
      `INSERT INTO messages(conversation_id,role,content)
       VALUES($1,'user',$2)`,
      [conversation.id, message]
    );

    const history = await pool.query(
      `SELECT role,content
       FROM messages
       WHERE conversation_id=$1
       ORDER BY id DESC
       LIMIT 20`,
      [conversation.id]
    );

    const messages = [
      {
        role: "system",
        content: "You are NOVA AI, a helpful, honest, respectful and age-appropriate AI assistant. Explain things clearly. Protect privacy. Do not provide instructions that facilitate violence, dangerous wrongdoing, sexual exploitation or self-harm. If a request is unsafe, explain briefly and offer a safer alternative. Never claim to have performed actions you have not performed."
      },
      ...history.rows.reverse()
    ];

    const url = baseUrl.replace(/\/+$/, "");

    const response = await fetch(
      `${url}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 1200
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("AI provider error:", response.status, data);

      return res.status(502).json({
        error: "AI provider error. Check your API settings."
      });
    }

    const answer = data.choices?.[0]?.message?.content;

    if (!answer || typeof answer !== "string") {
      return res.status(502).json({
        error: "The AI returned an empty response."
      });
    }

    const saved = await pool.query(
      `INSERT INTO messages(conversation_id,role,content)
       VALUES($1,'assistant',$2)
       RETURNING id,role,content,created_at`,
      [conversation.id, answer]
    );

    await pool.query(
      "UPDATE conversations SET updated_at=NOW() WHERE id=$1",
      [conversation.id]
    );

    res.json({
      conversationId: conversation.id,
      reply: saved.rows[0]
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "NOVA AI could not complete your request."
    });
  }
});

// SERVE WEBSITE
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// START SERVER
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NOVA AI running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
