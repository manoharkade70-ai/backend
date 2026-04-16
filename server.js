const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");
const Jimp = require("jimp");
const archiver = require("archiver");
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

// ================= ADMIN =================

// 🔥 BULK QR + ZIP
app.post("/create-token", async (req, res) => {
  const { value, count } = req.body;

  try {
    const qrList = [];

    for (let i = 0; i < count; i++) {

      const tokenId = Math.random().toString(36).substring(2, 10).toUpperCase();

      const token = new Token({
        tokenId,
        value,
        used: false
      });

      await token.save();

      const url = `https://frontend-t7zf.onrender.com/#/?token=${tokenId}`;

      const qrBuffer = await QRCode.toBuffer(url, {
        errorCorrectionLevel: "H"
      });

      const qrImage = await Jimp.read(qrBuffer);
      const logo = await Jimp.read("logo.png");

      logo.resize(50, 50);

      const x = (qrImage.bitmap.width - logo.bitmap.width) / 2;
      const y = (qrImage.bitmap.height - logo.bitmap.height) / 2;

      const whiteBg = new Jimp(60, 60, "#FFFFFF");
      qrImage.composite(whiteBg, x - 5, y - 5);
      qrImage.composite(logo, x, y);

      const finalQR = await qrImage.getBufferAsync(Jimp.MIME_PNG);

      qrList.push({
        tokenId,
        buffer: finalQR
      });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=qrcodes.zip");

    const archive = archiver("zip");
    archive.pipe(res);

    qrList.forEach(qr => {
      archive.append(qr.buffer, { name: `qr-${qr.tokenId}.png` });
    });

    await archive.finalize();

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "QR generation failed" });
  }
});

// OTHER APIs
app.get("/all-tokens", async (req, res) => {
  const tokens = await Token.find();
  res.json(tokens);
});

app.post("/clear-wallet", async (req, res) => {
  const { mobile } = req.body;
  await User.findOneAndUpdate({ mobile }, { wallet: 0 });
  res.json({ message: "Wallet cleared" });
});

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

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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