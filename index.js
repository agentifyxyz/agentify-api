require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
const { uploadCollectionMetadata } = require('./pinata');
const fs = require('fs');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const factoryAbi = JSON.parse(fs.readFileSync('./output/AgentifyFactory.abi', 'utf8'));
const collectionAbi = JSON.parse(fs.readFileSync('./output/AgentifyCollection.abi', 'utf8'));
const factory = new ethers.Contract(process.env.FACTORY_ADDRESS, factoryAbi, wallet);

async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });

  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('api_key', key)
    .eq('active', true)
    .single();

  if (error || !data) return res.status(401).json({ error: 'Invalid API key' });

  await supabase.from('api_keys').update({
    last_used_at: new Date().toISOString(),
    requests_count: data.requests_count + 1
  }).eq('id', data.id);

  req.agent = data;
  next();
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.get('/', (req, res) => {
  res.json({
    name: 'Agentify Protocol API',
    version: '1.0.0',
    factory: process.env.FACTORY_ADDRESS,
    chain: 'Base Mainnet',
    docs: 'https://docs.agentify.xyz'
  });
});

app.post('/v1/admin/keys', requireAdmin, async (req, res) => {
  const { agent_wallet, name } = req.body;
  if (!agent_wallet) return res.status(400).json({ error: 'agent_wallet required' });

  const { data, error } = await supabase
    .from('api_keys')
    .insert({ agent_wallet, name: name || 'default' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    success: true,
    api_key: data.api_key,
    agent_wallet: data.agent_wallet,
    message: 'Save this key — it will not be shown again'
  });
});

app.get('/v1/admin/keys', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, agent_wallet, name, active, requests_count, created_at, last_used_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ keys: data });
});

// ── CREATE DROP with Pinata IPFS ──────────────────────────
app.post('/v1/drops', requireApiKey, async (req, res) => {
  const {
    name, symbol, supply, price = '0',
    start_time, end_time = 0,
    royalty_fee = 0, royalty_recipient,
    revenue_recipient, base_uri = '',
    unrevealed_uri = 'https://api.agentify.xyz/unrevealed.json',
    // NEW: collection metadata for OpenSea
    description = '',
    collection_image = '',
    collection_banner = '',
    external_link = 'https://agentify.xyz'
  } = req.body;

  if (!name || !symbol || !supply) {
    return res.status(400).json({ error: 'name, symbol, supply are required' });
  }
  if (!revenue_recipient || !ethers.isAddress(revenue_recipient)) {
    return res.status(400).json({ error: 'Valid revenue_recipient address required' });
  }

  const royaltyAddr = royalty_recipient || revenue_recipient;
  const startTs = start_time || Math.floor(Date.now() / 1000);
  const priceWei = ethers.parseEther(price.toString());

  try {
    // Upload collection metadata to IPFS via Pinata
    console.log('Uploading collection metadata to IPFS...');
    const contractMetadataURI = await uploadCollectionMetadata({
      name,
      description,
      image: collection_image,
      banner_image: collection_banner,
      external_link,
      seller_fee_basis_points: royalty_fee,
      fee_recipient: royaltyAddr
    });
    console.log('Collection metadata URI:', contractMetadataURI);

    const tx = await factory.createDrop(
      name, symbol, supply, priceWei,
      startTs, end_time,
      royalty_fee, royaltyAddr, revenue_recipient,
      base_uri, unrevealed_uri,
      contractMetadataURI  // ← contractURI for OpenSea
    );

    console.log(`Creating drop "${name}" tx: ${tx.hash}`);
    const receipt = await tx.wait();

    const event = receipt.logs.find(log => {
      try { return factory.interface.parseLog(log)?.name === 'DropCreated'; }
      catch { return false; }
    });

    const parsed = factory.interface.parseLog(event);
    const contractAddress = parsed.args[0];

    const { data, error } = await supabase.from('collections').insert({
      agent_wallet: req.agent.agent_wallet,
      contract_address: contractAddress,
      tx_hash: tx.hash,
      name, symbol,
      max_supply: supply,
      price: price.toString(),
      start_time: startTs,
      end_time,
      royalty_fee,
      royalty_recipient: royaltyAddr,
      revenue_recipient,
      base_uri,
      unrevealed_uri,
      factory_address: process.env.FACTORY_ADDRESS
    }).select().single();

    if (error) console.error('Supabase error:', error.message);

    res.json({
      success: true,
      collection: {
        address: contractAddress,
        tx_hash: tx.hash,
        name, symbol, supply, price,
        contract_metadata_uri: contractMetadataURI,
        basescan: `https://basescan.org/address/${contractAddress}`,
        opensea: `https://opensea.io/assets/base/${contractAddress}`
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/drops', async (req, res) => {
  const { agent_wallet, limit = 20, offset = 0 } = req.query;

  let query = supabase
    .from('collections')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (agent_wallet) query = query.eq('agent_wallet', agent_wallet);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ drops: data, count: data.length });
});

app.get('/v1/drops/:address', async (req, res) => {
  const { address } = req.params;

  const { data, error } = await supabase
    .from('collections')
    .select('*')
    .eq('contract_address', address)
    .single();

  if (error) return res.status(404).json({ error: 'Collection not found' });

  try {
    const collection = new ethers.Contract(address, collectionAbi, provider);
    const [totalMinted, isMintActive, remainingSupply] = await Promise.all([
      collection.totalMinted(),
      collection.isMintActive(),
      collection.remainingSupply()
    ]);

    res.json({
      ...data,
      onchain: {
        total_minted: totalMinted.toString(),
        remaining_supply: remainingSupply.toString(),
        is_mint_active: isMintActive
      }
    });
  } catch {
    res.json(data);
  }
});

app.post('/v1/drops/:address/mint', requireApiKey, async (req, res) => {
  const { address } = req.params;
  const { to, quantity = 1 } = req.body;

  if (!to || !ethers.isAddress(to)) {
    return res.status(400).json({ error: 'Valid "to" address required' });
  }

  try {
    const collection = new ethers.Contract(address, collectionAbi, wallet);
    const price = await collection.price();
    const totalValue = price * BigInt(quantity);

    let tx;
    if (quantity === 1) {
      tx = await collection.mint(to, { value: totalValue });
    } else {
      tx = await collection.mintBatch(to, quantity, { value: totalValue });
    }

    console.log(`Minting ${quantity} token(s) tx: ${tx.hash}`);
    const receipt = await tx.wait();

    const { data: col } = await supabase
      .from('collections')
      .select('id, total_minted')
      .eq('contract_address', address)
      .single();

    if (col) {
      const mintRecords = [];
      for (let i = 0; i < quantity; i++) {
        mintRecords.push({
          collection_id: col.id,
          contract_address: address,
          minter_wallet: to,
          token_id: col.total_minted + i,
          tx_hash: tx.hash,
          price_paid: ethers.formatEther(totalValue)
        });
      }
      await supabase.from('mints').insert(mintRecords);
      await supabase.from('collections')
        .update({ total_minted: col.total_minted + quantity })
        .eq('id', col.id);
    }

    res.json({
      success: true,
      tx_hash: tx.hash,
      minted: quantity,
      to,
      basescan: `https://basescan.org/tx/${tx.hash}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/drops/:address/mints', async (req, res) => {
  const { address } = req.params;

  const { data, error } = await supabase
    .from('mints')
    .select('*')
    .eq('contract_address', address)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ mints: data, count: data.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Agentify Protocol API running on port ${PORT}`);
  console.log(`Factory: ${process.env.FACTORY_ADDRESS}`);
  console.log(`Wallet: ${wallet.address}`);
});
