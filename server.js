// server.js
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const app = express();

// Configuração do banco de dados PARA NUVEM
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:230655@localhost:5432/nahpora_delivery',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Configuração do Multer para upload de imagens - ADAPTADO PARA NUVEM
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    // Criar diretório se não existir
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Nome único para evitar conflitos
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Verificar se é imagem
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas!'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limite
  }
});

// Middleware para CORS - IMPORTANTE PARA NUVEM
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir arquivos uploads
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Rota raiz para servir o frontend
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
    let imagem_url = req.body.imagem_url; // URL existente se não houver upload
    
    // Se há nova imagem uploadada
    if (req.file) {
      imagem_url = '/uploads/' + req.file.filename;
    }
    
    if (id) {
      // Editar produto existente
      await pool.query(
        'UPDATE produtos SET nome=$1, descricao=$2, preco=$3, categoria=$4, imagem_url=$5, disponivel=$6 WHERE id=$7',
        [nome, descricao, parseFloat(preco), categoria, imagem_url, disponivel === 'true', id]
      );
    } else {
      // Adicionar novo produto
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
    // Primeiro buscar a imagem para deletar do sistema de arquivos
    const produtoResult = await pool.query('SELECT imagem_url FROM produtos WHERE id = $1', [req.params.id]);
    
    if (produtoResult.rows.length > 0) {
      const imagem_url = produtoResult.rows[0].imagem_url;
      // Se é uma imagem local (não URL externa), deletar o arquivo
      if (imagem_url && imagem_url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, 'public', imagem_url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }
    
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao excluir produto:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rotas para pedidos
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
    // Inserir cliente
    const clienteResult = await pool.query(
      'INSERT INTO clientes (nome, telefone, email, endereco) VALUES ($1, $2, $3, $4) RETURNING id',
      [cliente.nome, cliente.telefone, cliente.email || '', cliente.endereco]
    );
    
    const clienteId = clienteResult.rows[0].id;
    
    // Inserir pedido
    const pedidoResult = await pool.query(
      'INSERT INTO pedidos (cliente_id, endereco_entrega, forma_pagamento, observacoes, total) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [clienteId, endereco_entrega, forma_pagamento, observacoes, parseFloat(total)]
    );
    
    const pedidoId = pedidoResult.rows[0].id;
    
    // Inserir itens do pedido
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

// Rotas para configurações
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

// Rota para login admin
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

// Rota de saúde para verificar se API está funcionando
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Nahpora Delivery API está funcionando!' });
});

// Porta dinâmica para nuvem
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse: http://localhost:${PORT}`);
});