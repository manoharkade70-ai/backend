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

// ✅ Pre-load and resize logo ONCE when server starts
let logoBuffer = null;
sharp("logo.png")
  .resize(50, 50)
  .toBuffer()
  .then(buf => {
    logoBuffer = buf;
    console.log("Logo loaded");
  })
  .catch(err => console.log("Logo load failed:", err));

app.post("/create-token", async (req, res) => {
  const value = Number(req.body.value);
  const count = Number(req.body.count);

  try {
    if (!logoBuffer) {
      return res.status(500).json({ message: "Logo not ready" });
    }

    const tokenIds = Array.from({ length: count }, () =>
      require("crypto").randomBytes(4).toString("hex").toUpperCase()
    );

    await Token.insertMany(tokenIds.map(tokenId => ({
      tokenId,
      value,
      used: false
    })));

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=qrcodes.zip");

    const archive = archiver("zip", { zlib: { level: 1 } });
    archive.pipe(res);

    const BATCH_SIZE = 25; // can tune later

    for (let i = 0; i < tokenIds.length; i += BATCH_SIZE) {
      const batch = tokenIds.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(batch.map(async (tokenId) => {
        const url = `https://frontend-t7zf.onrender.com/#/?token=${tokenId}`;

        const qrBuffer = await QRCode.toBuffer(url, {
          errorCorrectionLevel: "H",
          width: 250,
          margin: 1
        });

        const finalQR = await sharp(qrBuffer)
          .composite([{ input: logoBuffer, gravity: "center" }])
          .png()
          .toBuffer();

        return { tokenId, buffer: finalQR };
      }));

      // 🔥 append immediately → no memory buildup
      results.forEach(qr => {
        archive.append(qr.buffer, { name: `qr-${qr.tokenId}.png` });
      });
    }

    await archive.finalize();

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "QR generation failed" });
  }
});

app.get("/all-tokens", async (req, res) => {
  try {
    const tokens = await Token.find();
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch tokens" });
  }
});

app.post("/clear-wallet", async (req, res) => {
  try {
    const { mobile } = req.body;
    await User.findOneAndUpdate({ mobile }, { wallet: 0 });
    res.json({ message: "Wallet cleared" });
  } catch (err) {
    res.status(500).json({ message: "Failed to clear wallet" });
  }
});

app.get("/export-users", async (req, res) => {
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
      sheet.addRow({ name: u.usedBy, mobile: u.mobile, tokenId: u.tokenId, date: u.date });
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
    res.json({ history, wallet: user ? user.wallet : 0 });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

// ================= SERVER =================
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});