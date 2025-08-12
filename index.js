// index.js
const express = require('express');
const cors = require('cors');

const app = express();
// Renderで必須：指定ポートは環境変数から
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ヘルスチェック
app.get('/api/ping', (req, res) => {
  res.json({ message: 'pong' });
});

// 病院名返却API（モック版）
// 仕様: ?code=H00002 のように指定 → C列と一致ならB列（病院名）を返す想定
app.get('/api/hospital', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code required' });

  // ★ここは明日Google Sheets APIに置き換える。今日は動作確認のための仮データ。
  if (code === 'H00001') return res.json({ matched: true, name: 'A病院' });
  if (code === 'H00002') return res.json({ matched: true, name: 'AB病院' });

  return res.json({ matched: false });
});

// 既定ルート（簡易表示）
app.get('/', (_req, res) => {
  res.send('Hospital API is running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
