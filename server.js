// server.js
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const app = express();

// =========================================================
// CONFIGURAÇÃO DO BANCO CORRIGIDA - USA BANCO DO RENDER
// =========================================================
const pool = new Pool({
  connectionString: 'postgresql://nahora_delivery_db_user:DjJS3iSDSiNwXcQU69Yjpr84vMeK3rcp@dpg-d43v2hjipnbc73cc8uk0-a/nahora_delivery_db',
  ssl: { rejectUnauthorized: false }
});

// =========================================================
// CONFIGURAÇÃO CLOUDINARY
// =========================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'nahora-delivery-uploads',
    format: async (req, file) => 'jpeg', 
    public_id: (req, file) => 'img-' + Date.now() + '-' + path.parse(file.originalname).name,
  },
});

const upload = multer({ 
    storage: storage, 
    limits: { fileSize: 5 * 1024 * 1024 }
});

// =========================================================
// DEBUG - TESTAR CONEXÃO COM BANCO
// =========================================================
async function testarConexaoBanco() {
  try {
    console.log('🔍 Testando conexão com banco de dados...');
    const client = await pool.connect();
    const dbInfo = await client.query('SELECT current_database(), current_user');
    console.log('✅ Conectado ao banco:', dbInfo.rows[0]);
    
    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('📊 Tabelas disponíveis:', tables.rows.map(row => row.table_name));
    
    client.release();
  } catch (err) {
    console.error('❌ Erro ao conectar com banco:', err.message);
  }
}

// =========================================================
// MIDDLEWARES
// =========================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// ROTA DE DEBUG - REMOVA DEPOIS QUE TUDO ESTIVER FUNCIONANDO
// =========================================================
app.get('/debug', async (req, res) => {
  try {
    const dbInfo = await pool.query('SELECT current_database(), current_user');
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    
    res.json({
      database: dbInfo.rows[0],
      tables: tables.rows,
      message: 'Conexão com banco de dados OK!'
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// =========================================================
// ROTAS DA APLICAÇÃO
// =========================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rotas para produtos
app.get('/api/produtos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos WHERE disponivel = true ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para todos os produtos (admin)
app.get('/api/admin/produtos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar produtos admin:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para adicionar/editar produto COM UPLOAD DE IMAGEM
app.post('/api/admin/produtos', upload.single('imagem'), async (req, res) => {
  const { id, nome, descricao, preco, categoria, disponivel } = req.body;
  
  try {
    let imagem_url = req.body.imagem_url;
    
    if (req.file) {
      imagem_url = req.file.path;
    }
    
    if (id) {
      await pool.query(
        'UPDATE produtos SET nome=$1, descricao=$2, preco=$3, categoria=$4, imagem_url=$5, disponivel=$6 WHERE id=$7',
        [nome, descricao, parseFloat(preco), categoria, imagem_url, disponivel === 'true', id]
      );
    } else {
      await pool.query(
        'INSERT INTO produtos (nome, descricao, preco, categoria, imagem_url, disponivel) VALUES ($1, $2, $3, $4, $5, $6)',
        [nome, descricao, parseFloat(preco), categoria, imagem_url, disponivel === 'true']
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao salvar produto:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para excluir produto
app.delete('/api/admin/produtos/:id', async (req, res) => {
  try {
    const produtoResult = await pool.query('SELECT imagem_url FROM produtos WHERE id = $1', [req.params.id]);
    
    if (produtoResult.rows.length > 0) {
      const imagem_url = produtoResult.rows[0].imagem_url;
      
      if (imagem_url && imagem_url.includes('cloudinary.com')) {
        const parts = imagem_url.split('/');
        const publicIdWithExt = parts[parts.length - 1]; 
        const publicId = publicIdWithExt.split('.')[0];
        const folder = parts[parts.length - 2]; 
        
        await cloudinary.uploader.destroy(`${folder}/${publicId}`);
      }
    }
    
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao excluir produto:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rotas de pedidos
app.get('/api/admin/pedidos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, c.nome as cliente_nome, c.telefone, c.endereco 
      FROM pedidos p 
      JOIN clientes c ON p.cliente_id = c.id 
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos', async (req, res) => {
  const { cliente, itens, endereco_entrega, forma_pagamento, observacoes, total } = req.body;
  
  try {
    const clienteResult = await pool.query(
      'INSERT INTO clientes (nome, telefone, email, endereco) VALUES ($1, $2, $3, $4) RETURNING id',
      [cliente.nome, cliente.telefone, cliente.email || '', cliente.endereco]
    );
    
    const clienteId = clienteResult.rows[0].id;
    
    const pedidoResult = await pool.query(
      'INSERT INTO pedidos (cliente_id, endereco_entrega, forma_pagamento, observacoes, total) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [clienteId, endereco_entrega, forma_pagamento, observacoes, parseFloat(total)]
    );
    
    const pedidoId = pedidoResult.rows[0].id;
    
    for (const item of itens) {
      await pool.query(
        'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
        [pedidoId, item.id, item.quantidade, parseFloat(item.preco)]
      );
    }
    
    res.json({ success: true, pedidoId });
  } catch (err) {
    console.error('Erro ao salvar pedido:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rotas de configurações
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM config');
    const config = {};
    result.rows.forEach(row => {
      config[row.chave] = row.valor;
    });
    res.json(config);
  } catch (err) {
    console.error('Erro ao buscar configurações:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', async (req, res) => {
  const { loja_aberta, telefone_whatsapp } = req.body;
  
  try {
    await pool.query('UPDATE config SET valor = $1 WHERE chave = $2', [loja_aberta, 'loja_aberta']);
    await pool.query('UPDATE config SET valor = $1 WHERE chave = $2', [telefone_whatsapp, 'telefone_whatsapp']);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota de login admin
app.post('/api/admin/login', async (req, res) => {
  const { usuario, senha } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM administradores WHERE usuario = $1 AND senha = $2', [usuario, senha]);
    
    if (result.rows.length > 0) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: 'Credenciais inválidas' });
    }
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Nahpora Delivery API está funcionando!' });
});

// Porta dinâmica para nuvem
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse: http://localhost:${PORT}`);
  
  // Executar teste de conexão
  await testarConexaoBanco();
});