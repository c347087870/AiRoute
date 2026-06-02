const axios = require('axios')

const BASE = 'http://localhost:3000'

async function test() {
  console.log('=== AiRoute Endpoint Test ===\n')

  console.log('1. GET /v1/models')
  try {
    const r = await axios.get(`${BASE}/v1/models`)
    console.log(`   Status: ${r.status}`)
    console.log(`   Response: ${JSON.stringify(r.data)}\n`)
  } catch (e) {
    console.log(`   FAIL: ${e.message}\n`)
  }

  console.log('2. POST /v1/messages (Anthropic, non-stream)')
  try {
    const r = await axios.post(`${BASE}/v1/messages`, {
      model: 'mimo-v2.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Say hi' }]
    }, { timeout: 30000 })
    console.log(`   Status: ${r.status}`)
    console.log(`   Content-Type: ${r.headers['content-type']}`)
    const preview = JSON.stringify(r.data).slice(0, 200)
    console.log(`   Response: ${preview}...\n`)
  } catch (e) {
    console.log(`   Status: ${e.response?.status || 'N/A'}`)
    console.log(`   FAIL: ${e.message}`)
    if (e.response?.data) console.log(`   Body: ${JSON.stringify(e.response.data).slice(0, 200)}`)
    console.log()
  }

  console.log('3. POST /v1/messages (Anthropic, stream)')
  try {
    const r = await axios.post(`${BASE}/v1/messages`, {
      model: 'mimo-v2.5-pro',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Say hi' }]
    }, { timeout: 30000, responseType: 'stream' })
    console.log(`   Status: ${r.status}`)
    console.log(`   Content-Type: ${r.headers['content-type']}`)
    const chunks = []
    await new Promise((resolve, reject) => {
      r.data.on('data', (chunk) => {
        chunks.push(chunk.toString())
        if (chunks.length >= 3) { r.data.destroy(); resolve() }
      })
      r.data.on('end', resolve)
      r.data.on('error', reject)
      setTimeout(resolve, 10000)
    })
    console.log(`   Got ${chunks.length} chunks`)
    if (chunks.length > 0) console.log(`   First chunk: ${chunks[0].slice(0, 150)}...\n`)
    else console.log('   (no data received)\n')
  } catch (e) {
    console.log(`   Status: ${e.response?.status || 'N/A'}`)
    console.log(`   FAIL: ${e.message}\n`)
  }

  console.log('4. POST /v1/chat/completions (OpenAI, non-stream)')
  try {
    const r = await axios.post(`${BASE}/v1/chat/completions`, {
      model: 'mimo-v2.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Say hi' }]
    }, { timeout: 30000 })
    console.log(`   Status: ${r.status}`)
    const preview = JSON.stringify(r.data).slice(0, 200)
    console.log(`   Response: ${preview}...\n`)
  } catch (e) {
    console.log(`   Status: ${e.response?.status || 'N/A'}`)
    console.log(`   FAIL: ${e.message}`)
    if (e.response?.data) console.log(`   Body: ${JSON.stringify(e.response.data).slice(0, 200)}`)
    console.log()
  }

  console.log('5. POST /v1/chat/completions (OpenAI, stream)')
  try {
    const r = await axios.post(`${BASE}/v1/chat/completions`, {
      model: 'mimo-v2.5-pro',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Say hi' }]
    }, { timeout: 30000, responseType: 'stream' })
    console.log(`   Status: ${r.status}`)
    console.log(`   Content-Type: ${r.headers['content-type']}`)
    const chunks = []
    await new Promise((resolve, reject) => {
      r.data.on('data', (chunk) => {
        chunks.push(chunk.toString())
        if (chunks.length >= 3) { r.data.destroy(); resolve() }
      })
      r.data.on('end', resolve)
      r.data.on('error', reject)
      setTimeout(resolve, 10000)
    })
    console.log(`   Got ${chunks.length} chunks`)
    if (chunks.length > 0) console.log(`   First chunk: ${chunks[0].slice(0, 150)}...\n`)
    else console.log('   (no data received)\n')
  } catch (e) {
    console.log(`   Status: ${e.response?.status || 'N/A'}`)
    console.log(`   FAIL: ${e.message}\n`)
  }

  console.log('=== Test Complete ===')
}

test().catch(console.error)
