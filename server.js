const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Google Search endpoint ──────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, num = 8 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query param q' });

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&num=${num}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) return res.status(500).json({ error: data.error.message });

    const results = (data.items || []).map(item => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
      source: item.displayLink
    }));

    res.json({ results, totalResults: data.searchInformation?.totalResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-search: runs several Google queries in parallel ───────────────────
app.post('/api/search/multi', async (req, res) => {
  const { queries } = req.body;
  if (!queries || !Array.isArray(queries)) {
    return res.status(400).json({ error: 'Body must have a queries array' });
  }

  try {
    const searches = queries.map(q =>
      fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&num=5`)
        .then(r => r.json())
        .then(data => ({
          query: q,
          results: (data.items || []).map(item => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet,
            source: item.displayLink
          }))
        }))
    );

    const allResults = await Promise.all(searches);
    res.json({ searches: allResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leads endpoint: Google search → Claude synthesis ───────────────────────
app.post('/api/leads', async (req, res) => {
  const { filter = 'all', topic = '' } = req.body;

  // Build targeted Google queries based on filter + topic
  const base = topic || 'design branding UX';
  const queries = [
    `site:producthunt.com new product launch ${topic || 'startup'} 2025 2026`,
    `startup "just raised" OR "seed round" OR "series A" ${topic || 'design'} 2025 2026`,
    `founder "looking for designer" OR "need a designer" OR "rebrand" ${topic || ''}`,
    `"design trends" OR "branding trends" ${new Date().getFullYear()}`,
    `${filter !== 'all' ? filter : 'startup'} ${base} brand identity problem`,
  ];

  try {
    // Step 1: Run Google searches in parallel
    const searches = await Promise.all(
      queries.map(q =>
        fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&num=5`)
          .then(r => r.json())
          .then(data => ({
            query: q,
            results: (data.items || []).map(i => `${i.title} — ${i.snippet} (${i.displayLink})`).join('\n')
          }))
      )
    );

    const searchContext = searches.map(s => `Query: "${s.query}"\n${s.results}`).join('\n\n---\n\n');

    // Step 2: Send to Claude to synthesize into structured leads
    const filterContext = filter === 'all'
      ? 'startups, founders, and established brands that work with creatives'
      : filter === 'startup' ? 'early-stage startups needing design'
      : filter === 'founder' ? 'solo founders and small team founders'
      : 'established brands launching new products or rebrands';

    const prompt = `You are a lead generation AI for a designer or design agency.

Here is LIVE Google search data pulled right now:

${searchContext}

Using this real data, generate 6 specific leads for design services. 
Filter focus: ${filterContext}
${topic ? `Topic focus: ${topic}` : ''}

Ground leads in the real companies, founders, and trends you see in the search results above. For each lead:
- If a real company/founder appears in the results, use them
- Pull their actual known problem from the snippet context
- Mark source as where you found them (Product Hunt, News, Twitter, etc.)
- If you need to fill gaps, create plausible leads inspired by real patterns

Return ONLY valid JSON, no markdown:
{
  "leads": [
    {
      "name": "Full Name",
      "company": "Company Name", 
      "type": "startup|founder|brand",
      "role": "Role/Title",
      "problem": "Specific design problem, grounded in real context",
      "solution_seeking": "What design solution they need",
      "topics": ["topic1", "topic2", "topic3"],
      "score": 85,
      "hot": true|false,
      "context": "2-3 sentences. Mention real signals: 'Just launched on Product Hunt', 'Recently raised $Xm seed', etc.",
      "source": "Product Hunt|News|Twitter|LinkedIn|Crunchbase|Generated"
    }
  ],
  "hot_topics": [
    { "name": "Real trending topic from search results", "heat": "high|med|low", "count": 42 }
  ],
  "founder_problems": [
    { "tag": "VISIBILITY", "text": "Real pattern observed from search data", "type": "startup|founder|brand" }
  ]
}

hot_topics: 6 items. founder_problems: 4 items.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(c => c.type === 'text').map(c => c.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Outreach endpoint ───────────────────────────────────────────────────────
app.post('/api/outreach', async (req, res) => {
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: 'Missing lead' });

  const prompt = `Write a short, confident LinkedIn outreach message from a designer to ${lead.name}, ${lead.role} at ${lead.company}.

Their problem: ${lead.problem}
What they want to build: ${lead.solution_seeking}
Context: ${lead.context}

Rules:
- 4-6 sentences max
- No cliche openers like "I hope this message finds you well"
- Reference their specific problem naturally
- End with one clear, low-friction ask
- Sound like a real creative professional, not a salesperson`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await claudeRes.json();
    const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
    res.json({ message: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Designflow backend running on port ${PORT}`));
