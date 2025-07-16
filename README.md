# 🎥 Omegle Clone - Random Video & Text Chat App

This is a full-stack real-time anonymous video and text chat web application, inspired by [Omegle](https://www.omegle.com). Users are randomly paired with strangers for 1-on-1 conversations, and can skip to a new partner at any time.

---

## 🚀 Features

- ✅ Anonymous 1-on-1 video chat using **WebRTC**
- ✅ Real-time text messaging via **Socket.IO**
- ✅ Skip button to leave current chat and find a new partner
- ✅ Auto re-matching via queue-based matchmaking
- ✅ Clean and responsive UI (CSS customizable)
- ✅ Peer-to-peer media transfer (not streamed via server)

---

## 🧠 Tech Stack

| Layer        | Technology       |
|--------------|------------------|
| Frontend     | React.js (Vite)  |
| Realtime     | Socket.IO        |
| Media Stream | WebRTC, getUserMedia |
| Backend      | Node.js + Express |
| Styling      | Plain CSS / Optional Tailwind |

---

## 📦 Folder Structure

omegle-clone/
├── client/ # React frontend
│ ├── App.jsx
│ ├── App.css
│ └── socket.js
├── server/ # Express backend
│ └── index.js
├── README.md
├── package.json # Backend dependencies
└── ...


---

## ⚙️ Installation & Setup

### 1. Clone the repo
```bash
git clone https://github.com/yourusername/omegle-clone.git
cd omegle-clone

cd server
npm install
npm start
# ✅ Server will run at http://localhost:3001

cd ../client
npm install
npm run dev
# ✅ Client will run at http://localhost:5173


🛠 How It Works
When a user joins, they are placed in a waiting queue.

As soon as 2 users are in queue, they are matched.

Once matched:

Text chat is enabled.

Video and mic access is granted using getUserMedia().

WebRTC is used to establish peer-to-peer video connection.

Either user can click "Skip", which:

Disconnects from current peer.

Places both users back in the queue.

✅ TODO (Next Phases)
 Add interest-based matchmaking

 Add mute/unmute, camera toggle buttons

 Add report/block user feature

 Store chat logs anonymously (optional)

 Mobile responsive version

🧑‍💻 Developer
Bhanu Pratap Singh

Built with ❤️ using MERN + WebRTC
Instagram: @bhanu_codes
GitHub: @yourgithub

📄 License
MIT License © 2025 Bhanu Pratap Singh
  
