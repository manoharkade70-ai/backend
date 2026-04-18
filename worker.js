const { Worker } = require("bullmq");
const QRCode = require("qrcode");
const sharp = require("sharp");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config();

// DB connect
mongoose.connect(process.env.MONGO_URI);

// Models (same as your server)
const tokenSchema = new mongoose.Schema({
  tokenId: String,
  value: Number,
  used: Boolean
});
const Token = mongoose.model("Token", tokenSchema);

// Load logo once
let logoBuffer = null;

(async () => {
  logoBuffer = await sharp("logo.png")
    .resize(50, 50)
    .toBuffer();
})();

new Worker("qr-jobs", async job => {
  try {
    console.log("🔥 Processing job:", job.id);

    const { value, count } = job.data;

    const tokenIds = Array.from({ length: count }, () =>
      require("crypto").randomBytes(4).toString("hex").toUpperCase()
    );

    console.log("📦 Tokens generated:", tokenIds.length);

    await Token.insertMany(tokenIds.map(tokenId => ({
      tokenId,
      value,
      used: false
    })));

    console.log("💾 Tokens saved to DB");

    const outputDir = path.join(__dirname, "output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    const outputPath = path.join(outputDir, `qrs-${job.id}.zip`);
    const output = fs.createWriteStream(outputPath);

    const archive = archiver("zip", { zlib: { level: 1 } });
    archive.pipe(output);

    const BATCH_SIZE = 50;

    for (let i = 0; i < tokenIds.length; i += BATCH_SIZE) {
      const batch = tokenIds.slice(i, i + BATCH_SIZE);

      console.log(`⚙️ Processing batch ${i / BATCH_SIZE + 1}`);

      const results = await Promise.all(batch.map(async (tokenId) => {
        const url = `https://frontend-t7zf.onrender.com/#/?token=${tokenId}`;

        const qrBuffer = await QRCode.toBuffer(url, {
          errorCorrectionLevel: "H",
          width: 220
        });

        const finalQR = await sharp(qrBuffer)
          .composite([{ input: logoBuffer, gravity: "center" }])
          .png()
          .toBuffer();

        return { tokenId, buffer: finalQR };
      }));

      results.forEach(qr => {
        archive.append(qr.buffer, { name: `qr-${qr.tokenId}.png` });
      });
    }

    console.log("📦 Finalizing ZIP...");

    await archive.finalize();

    // 🔥 THIS IS THE FIX (wait for file to finish writing)
    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
    });

    console.log("✅ ZIP complete:", outputPath);

    return { filePath: outputPath };

  } catch (err) {
    console.error("❌ Worker error:", err);
    throw err;
  }
}, {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
    tls: {}
  },
  concurrency: 1
});