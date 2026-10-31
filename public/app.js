const $ = (id) => document.getElementById(id);

let token = localStorage.getItem("nova_token");
let currentUser = null;
let currentConversation = null;
let conversations = [];
let busy = false;

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`/api${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

/* AUTHENTICATION */

function setAuthTab(tab) {
  $("loginTab").classList.toggle("active", tab === "login");
  $("registerTab").classList.toggle("active", tab === "register");
  $("nameWrap").classList.toggle("hidden", tab !== "register");
  $("authSubmit").textContent = tab === "login" ? "Log in" : "Create account";
  $("authError").textContent = "";
  $("authForm").dataset.mode = tab;
}

$("loginTab").onclick = () => setAuthTab("login");
$("registerTab").onclick = () => setAuthTab("register");

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const mode = $("authForm").dataset.mode || "login";
  const username = $("username").value.trim();
  const email = $("email").value.trim();
  const password = $("password").value;

  $("authError").textContent = "";
  $("authSubmit").disabled = true;
  $("authSubmit").textContent = "Please wait...";

  try {
    const result = await api(
      mode === "login" ? "/auth/login" : "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({
          username,
          email,
          password
        })
      }
    );

    token = result.token;
    currentUser = result.user;
    localStorage.setItem("nova_token", token);

    await bootApp();
  } catch (error) {
    $("authError").textContent = error.message;
  } finally {
    $("authSubmit").disabled = false;
    $("authSubmit").textContent =
      mode === "login" ? "Log in" : "Create account";
  }
});

/* APP STARTUP */

async function bootApp() {
  try {
    const result = await api("/me");
    currentUser = result.user || result;

    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");

    $("userName").textContent =
      currentUser.username || "NOVA User";

    $("userEmail").textContent =
      currentUser.email || "";

    $("avatar").textContent =
      (currentUser.username || "N").charAt(0).toUpperCase();

    await loadConversations();
    showWelcome();
  } catch (error) {
    logout(false);
  }
}

/* CONVERSATIONS */

async function loadConversations() {
  const result = await api("/conversations");

  conversations = Array.isArray(result)
    ? result
    : result.conversations || [];

  renderChatList();
}

function renderChatList() {
  const list = $("chatList");
  list.innerHTML = "";

  conversations.forEach((conversation) => {
    const item = document.createElement("div");

    item.className =
      "chat-item" +
      (conversation.id === currentConversation ? " active" : "");

    item.textContent = conversation.title || "New conversation";
    item.title = conversation.title || "New conversation";

    item.onclick = () => openConversation(conversation.id);

    list.appendChild(item);
  });
}

function showWelcome() {
  currentConversation = null;
  $("welcome").classList.remove("hidden");
  $("messages").innerHTML = "";
  $("messages").classList.add("hidden");
  $("welcome").style.display = "flex";
  renderChatList();
}

async function createNewChat() {
  try {
    const result = await api("/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "New conversation" })
    });

    const conversation = result.conversation || result;

    currentConversation = conversation.id;

    await loadConversations();
    showChatArea();
    $("messages").innerHTML = "";
  } catch (error) {
    alert(error.message);
  }
}

function showChatArea() {
  $("welcome").classList.add("hidden");
  $("welcome").style.display = "none";
  $("messages").classList.remove("hidden");
}

async function openConversation(id) {
  try {
    currentConversation = id;
    showChatArea();
    $("messages").innerHTML = "";

    const result = await api(`/conversations/${id}/messages`);
    const messages = Array.isArray(result)
      ? result
      : result.messages || [];

    messages.forEach((message) => {
      addMessage(
        message.role,
        message.content
      );
    });

    renderChatList();
    scrollToBottom();
  } catch (error) {
    alert(error.message);
  }
}

/* MESSAGE DISPLAY */

function addMessage(role, content) {
  showChatArea();

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "👤" : "✦";

  const body = document.createElement("div");
  body.className = "message-body";

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "NOVA AI";

  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = content;

  body.appendChild(label);
  body.appendChild(text);

  if (role === "assistant") {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.textContent = "Copy response";

    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(content);
        copy.textContent = "Copied!";
        setTimeout(() => {
          copy.textContent = "Copy response";
        }, 1500);
      } catch {
        copy.textContent = "Copy unavailable";
      }
    };

    actions.appendChild(copy);
    body.appendChild(actions);
  }

  wrapper.appendChild(avatar);
  wrapper.appendChild(body);

  $("messages").appendChild(wrapper);
  scrollToBottom();
}

function scrollToBottom() {
  $("chatScroll").scrollTop = $("chatScroll").scrollHeight;
}

/* AI CHAT */

async function sendMessage(text) {
  text = text.trim();

  if (!text || busy) return;

  if (!currentConversation) {
    await createNewChat();
  }

  busy = true;

  $("messageInput").value = "";
  $("sendBtn").disabled = true;

  addMessage("user", text);

  const typing = document.createElement("div");
  typing.className = "typing";
  typing.textContent = "NOVA AI is thinking...";
  $("messages").appendChild(typing);

  scrollToBottom();

  try {
    const result = await api("/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: currentConversation,
        message: text
      })
    });

    typing.remove();

    addMessage(
      "assistant",
      result.reply || result.message || "No response received."
    );

    await loadConversations();
  } catch (error) {
    typing.remove();

    addMessage(
      "assistant",
      "I couldn't complete that request. " + error.message
    );
  } finally {
    busy = false;
    $("sendBtn").disabled = false;
    $("messageInput").focus();
  }
}

/* INPUT CONTROLS */

$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage($("messageInput").value);
});

$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage($("messageInput").value);
  }
});

$("messageInput").addEventListener("input", () => {
  $("messageInput").style.height = "auto";
  $("messageInput").style.height =
    Math.min($("messageInput").scrollHeight, 150) + "px";
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    sendMessage(button.dataset.prompt || button.textContent);
  });
});

$("newChat").onclick = createNewChat;

/* MOBILE SIDEBAR */

$("menuBtn").onclick = () => {
  $("sidebar").classList.toggle("open");
};

$("chatList").addEventListener("click", () => {
  $("sidebar").classList.remove("open");
});

/* LOGOUT */

function logout(showAuth = true) {
  localStorage.removeItem("nova_token");

  token = null;
  currentUser = null;
  currentConversation = null;
  conversations = [];

  $("app").classList.add("hidden");

  if (showAuth) {
    $("authScreen").classList.remove("hidden");
  }
}

$("logout").onclick = () => logout(true);

/* INITIALIZATION */

setAuthTab("login");

if (token) {
  bootApp();
} else {
  $("authScreen").classList.remove("hidden");
  $("app").classList.add("hidden");
}
