const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const QRCode = require("qrcode");
const Jimp = require("jimp");
const ExcelJS = require("exceljs");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// ================= MODELS =================

// Token Schema
const tokenSchema = new mongoose.Schema({
  tokenId: String,
  value: Number,
  used: Boolean,
  usedBy: String,
  mobile: String,
  date: Date
});

const Token = mongoose.model("Token", tokenSchema);

// User Schema
const userSchema = new mongoose.Schema({
  name: String,
  mobile: String,
  wallet: { type: Number, default: 0 }
});

const User = mongoose.model("User", userSchema);

// ================= ADMIN APIs =================

// CREATE TOKEN
app.post("/create-token", async (req, res) => {
  const { value } = req.body;

  const tokenId = Math.random().toString(36).substring(2, 10).toUpperCase();

  const token = new Token({
    tokenId,
    value,
    used: false
  });

  await token.save();

  try {
    // 🔥 IMPORTANT: replace after frontend deploy
    const url = `https://frontend-t7zf.onrender.com/#/?token=${tokenId}`;

const qrBuffer = await QRCode.toBuffer(url);

const qrImage = await Jimp.read(qrBuffer);
const logo = await Jimp.read("logo.png");

logo.resize(45, 45);

const x = (qrImage.bitmap.width - logo.bitmap.width) / 2;
const y = (qrImage.bitmap.height - logo.bitmap.height) / 2;

qrImage.composite(logo, x, y);

const finalQR = await qrImage.getBase64Async(Jimp.MIME_PNG);

res.json({
  message: "Token created",
  qr: finalQR
});
  } catch (err) {
    res.json({ message: "QR generation failed" });
  }
});

// GET ALL TOKENS
app.get("/all-tokens", async (req, res) => {
  const tokens = await Token.find();
  res.json(tokens);
});

// CLEAR WALLET (ADMIN)
app.post("/clear-wallet", async (req, res) => {
  const { mobile } = req.body;

  await User.findOneAndUpdate(
    { mobile },
    { wallet: 0 }
  );

  res.json({ message: "Wallet cleared" });
});

// EXPORT USERS (EXCEL)
app.get("/export-users", async (req, res) => {
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

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  res.setHeader(
    "Content-Disposition",
    "attachment; filename=users.xlsx"
  );

  await workbook.xlsx.write(res);
  res.end();
});

// ================= USER APIs =================

// REDEEM TOKEN
app.post("/redeem-token", async (req, res) => {
  const { tokenId, name, mobile } = req.body;

  const token = await Token.findOne({ tokenId });

  if (!token) {
    return res.json({ message: "Invalid token" });
  }

  if (token.used) {
    return res.json({ message: "Already used" });
  }

  token.used = true;
  token.usedBy = name;
  token.mobile = mobile;
  token.date = new Date();

  await token.save();

  let user = await User.findOne({ mobile });

  if (!user) {
    user = new User({ name, mobile, wallet: 0 });
  }

  user.wallet += token.value;
  await user.save();

  res.json({ message: `₹${token.value} added to wallet` });
});

// USER HISTORY
app.get("/user-history/:mobile", async (req, res) => {
  const history = await Token.find({ mobile: req.params.mobile });

  const user = await User.findOne({ mobile: req.params.mobile });

  res.json({
    history,
    wallet: user ? user.wallet : 0
  });
});

// ================= SERVER =================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});