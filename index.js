const express = require('express');
const app = express();

// ✅ Renderで動作させるために「PORT」を環境変数から取得
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello from Render!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
