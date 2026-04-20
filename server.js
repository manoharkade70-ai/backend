const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");
const sharp = require("sharp");
const archiver = require("archiver");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected");

    // 🔥 CREATE ADMIN ONCE
   
  })
  .catch(err => console.log(err));
// ================= MODELS =================

// 🔐 Admin Schema


const tokenSchema = new mongoose.Schema({
  tokenId: String,
  value: Number,
  used: Boolean,
  usedBy: String,
  mobile: String,
  date: Date
});
const Token = mongoose.model("Token", tokenSchema);

const userSchema = new mongoose.Schema({
  name: String,
  mobile: String,
  wallet: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

// ================= ADMIN SECURITY =================

// 🔐 Middleware
function checkAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// 🔐 FINAL LOGIN (ENV BASED)
app.post("/admin-login", (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Wrong password" });
  }

  res.json({ token: process.env.ADMIN_KEY });
});

// ================= LOGO =================

let logoBuffer = null;
sharp("logo.png")
  .resize(50, 50)
  .toBuffer()
  .then(buf => {
    logoBuffer = buf;
    console.log("Logo loaded");
  })
  .catch(err => console.log("Logo load failed:", err));

// ================= QUEUE =================

const { Queue } = require("bullmq");

const qrQueue = new Queue("qr-jobs", {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
    tls: {}
  }
});

// ================= ADMIN ROUTES =================

app.post("/create-token", checkAdmin, async (req, res) => {
  const { value, count } = req.body;

  // 🔥 LIMIT
  if (count > 1000) {
    return res.status(400).json({ message: "Limit exceeded" });
  }

  try {
    const job = await qrQueue.add("generate-qrs", { value, count });

    res.json({
      message: "Job started",
      jobId: job.id
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to start job" });
  }
});

app.get("/job-status/:id", async (req, res) => {
  const job = await qrQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ message: "Job not found" });

  const state = await job.getState();

  res.json({
    status: state,
    result: job.returnvalue || null
  });
});

app.get("/download/:id", async (req, res) => {
  const job = await qrQueue.getJob(req.params.id);

  if (!job || job.returnvalue?.filePath == null) {
    return res.status(400).json({ message: "File not ready" });
  }

  res.download(job.returnvalue.filePath);
});

app.get("/all-tokens", checkAdmin, async (req, res) => {
  try {
    const tokens = await Token.find();
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch tokens" });
  }
});

app.post("/clear-wallet", checkAdmin, async (req, res) => {
  try {
    const { mobile } = req.body;
    await User.findOneAndUpdate({ mobile }, { wallet: 0 });
    res.json({ message: "Wallet cleared" });
  } catch (err) {
    res.status(500).json({ message: "Failed to clear wallet" });
  }
});

app.get("/export-users", checkAdmin, async (req, res) => {
  try {
    const users = await Token.find({ used: true });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Users");

    sheet.columns = [
      { header: "Name", key: "name" },
      { header: "Mobile", key: "mobile" },
      { header: "Token", key: "tokenId" },
      { header: "Date", key: "date" }
    ];

    users.forEach(u => {
      sheet.addRow({
        name: u.usedBy,
        mobile: u.mobile,
        tokenId: u.tokenId,
        date: u.date
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=users.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ message: "Failed to export users" });
  }
});

// ================= USER =================

app.post("/redeem-token", async (req, res) => {
  try {
    const tokenId = req.body.tokenId?.trim().toUpperCase();
    const { name, mobile } = req.body;

    if (!tokenId || !name || !mobile) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const token = await Token.findOne({ tokenId });

    if (!token) return res.json({ message: "Invalid token" });
    if (token.used) return res.json({ message: "Already used" });

    token.used = true;
    token.usedBy = name;
    token.mobile = mobile;
    token.date = new Date();
    await token.save();

    let user = await User.findOne({ mobile });
    if (!user) user = new User({ name, mobile, wallet: 0 });

    user.wallet += token.value;
    await user.save();

    res.json({ message: `₹${token.value} added to wallet` });
  } catch (err) {
    res.status(500).json({ message: "Failed to redeem token" });
  }
});

app.get("/user-history/:mobile", async (req, res) => {
  try {
    const history = await Token.find({ mobile: req.params.mobile });
    const user = await User.findOne({ mobile: req.params.mobile });

    res.json({
      history,
      wallet: user ? user.wallet : 0
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

// ================= SERVER =================
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});