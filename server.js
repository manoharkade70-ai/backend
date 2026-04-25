const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");
const archiver = require("archiver");
const Jimp = require("jimp"); // ✅ ADDED (ONLY NEW LINE)
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// ================= MODELS =================

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

function checkAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// 🔐 LOGIN
app.post("/admin-login", (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Wrong password" });
  }

  res.json({ token: process.env.ADMIN_KEY });
});

// ================= QR GENERATION =================

app.post("/create-token", checkAdmin, async (req, res) => {
  const { value, count } = req.body;

  if (count > 1000) {
    return res.status(400).json({ message: "Limit exceeded" });
  }

  try {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=qrcodes.zip");

    const archive = archiver("zip");
    archive.pipe(res);

    for (let i = 0; i < count; i++) {
      const tokenId = Math.random().toString(36).substring(2, 10).toUpperCase();

      await Token.create({
        tokenId,
        value,
        used: false,
        date: new Date()
      });

      // ================= QR WITH LOGO FIX =================

      const qrBuffer = await QRCode.toBuffer(
        `https://frontend-t7zf.onrender.com/#/redeem/${tokenId}`
      );

      const qrImage = await Jimp.read(qrBuffer);
      const logo = await Jimp.read("logo.png"); // ⚠️ place logo.png in backend root

      logo.resize(80, 80); // safe size

      qrImage.composite(
        logo,
        qrImage.bitmap.width / 2 - 40,
        qrImage.bitmap.height / 2 - 40
      );

      const finalBuffer = await qrImage.getBufferAsync(Jimp.MIME_PNG);

      archive.append(finalBuffer, { name: `${tokenId}.png` });

      // ================= END FIX =================
    }

    await archive.finalize();

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "QR generation failed" });
  }
});

// ================= DATE GROUP API =================

app.get("/tokens-by-date", checkAdmin, async (req, res) => {
  try {
    const tokens = await Token.find();

    const grouped = {};

    tokens.forEach(t => {
      if (!t.date) return;

      const d = new Date(t.date).toLocaleDateString();

      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(t);
    });

    res.json(grouped);

  } catch {
    res.status(500).json({ message: "Error grouping tokens" });
  }
});

// ================= ADMIN ROUTES =================

app.get("/all-tokens", checkAdmin, async (req, res) => {
  const tokens = await Token.find();
  res.json(tokens);
});

app.post("/clear-wallet", checkAdmin, async (req, res) => {
  const { mobile } = req.body;
  await User.findOneAndUpdate({ mobile }, { wallet: 0 });
  res.json({ message: "Wallet cleared" });
});

// ================= EXCEL =================

app.get("/export-users", checkAdmin, async (req, res) => {
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

  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=users.xlsx");

  await workbook.xlsx.write(res);
  res.end();
});

// ================= USER =================

app.post("/redeem-token", async (req, res) => {
  const tokenId = req.body.tokenId?.trim().toUpperCase();
  const { name, mobile } = req.body;

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
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});