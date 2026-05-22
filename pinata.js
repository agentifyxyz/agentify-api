const axios = require('axios');

async function uploadJSONToIPFS(json) {
  const response = await axios.post(
    'https://api.pinata.cloud/pinning/pinJSONToIPFS',
    json,
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PINATA_JWT}`
      }
    }
  );
  return `ipfs://${response.data.IpfsHash}`;
}

async function uploadMetadataFolder(tokens) {
  // Upload each token metadata
  const hashes = [];
  for (const token of tokens) {
    const uri = await uploadJSONToIPFS(token);
    hashes.push(uri);
  }
  return hashes;
}

async function uploadCollectionMetadata({ name, description, image, banner_image, external_link, seller_fee_basis_points, fee_recipient }) {
  const metadata = {
    name,
    description: description || '',
    image: image || '',
    banner_image: banner_image || '',
    external_link: external_link || 'https://agentify.xyz',
    seller_fee_basis_points: seller_fee_basis_points || 0,
    fee_recipient: fee_recipient || ''
  };
  return await uploadJSONToIPFS(metadata);
}

module.exports = { uploadJSONToIPFS, uploadCollectionMetadata, uploadMetadataFolder };
