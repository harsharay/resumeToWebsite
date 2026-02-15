# Configuration Guide for ResumeToSite

## API Configuration

### Step 1: Get Your Anthropic API Key

1. Visit: https://console.anthropic.com/
2. Sign up or log in with your account
3. Navigate to "API Keys" in the dashboard
4. Click "Create Key"
5. Name your key (e.g., "ResumeToSite Production")
6. Copy the key - it will look like: `sk-ant-api03-xxxxx...`

**Important**: Keep this key secure! Never share it publicly or commit it to git.

### Step 2: Add API Key to Application

Open `resume-to-site-app.html` and find this line (around line 738):

```javascript
const API_KEY = 'YOUR_ANTHROPIC_API_KEY_HERE';
```

Replace it with:

```javascript
const API_KEY = 'sk-ant-api03-your-actual-key-here';
```

## Deployment Options

### Option 1: Local Testing (Easiest)

Just open the HTML file in your browser:
```
Double-click resume-to-site-app.html
```

### Option 2: Netlify Drop (Recommended for MVP)

1. Go to https://app.netlify.com/drop
2. Drag and drop your `resume-to-site-app.html` file
3. Get instant deployment with custom URL
4. Free SSL certificate included

### Option 3: GitHub Pages

1. Create new repository on GitHub
2. Upload `resume-to-site-app.html` (rename to `index.html`)
3. Go to Settings → Pages
4. Select main branch
5. Your site will be live at: `https://yourusername.github.io/repo-name`

### Option 4: Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Run in your project folder: `vercel`
3. Follow the prompts
4. Automatic deployments on every push

### Option 5: Custom Domain + Cloudflare Pages

1. Buy domain (e.g., resumetosite.com)
2. Go to Cloudflare Pages
3. Upload your HTML file
4. Connect custom domain
5. Free CDN, SSL, and DDoS protection

## Environment Variables (For Production)

For security in production, move API key to environment variables:

### Using Netlify:

1. Go to Site Settings → Build & Deploy → Environment
2. Add variable: `ANTHROPIC_API_KEY`
3. Update your code to use: `process.env.ANTHROPIC_API_KEY`

**Note**: You'll need to convert to a Node.js backend for this.

## Recommended Next Steps

### Convert to Backend (Secure API Key)

Create a simple Express.js backend:

```javascript
// server.js
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

app.post('/api/generate', async (req, res) => {
  const { resumeContent } = req.body;
  
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Generate website from this resume: ${resumeContent}`
    }]
  });
  
  res.json({ html: message.content[0].text });
});

app.listen(3000);
```

Deploy backend to:
- Railway
- Render
- Heroku
- Fly.io

### File Structure for Production

```
resume-to-site/
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── backend/
│   ├── server.js
│   ├── routes/
│   │   └── generate.js
│   └── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Cost Estimates

### Anthropic API Costs
- Claude Sonnet 4: ~$3 per 1M input tokens, ~$15 per 1M output tokens
- Average resume: ~1,000 input tokens
- Average website: ~3,000 output tokens
- **Cost per generation**: ~$0.048 (about 5 cents)

### Monthly Costs (Estimated)

**Low Traffic** (100 generations/month):
- API costs: ~$5/month
- Hosting: Free (Netlify/Vercel)
- **Total: $5/month**

**Medium Traffic** (1,000 generations/month):
- API costs: ~$48/month
- Hosting: Free or ~$10/month
- **Total: $48-58/month**

**High Traffic** (10,000 generations/month):
- API costs: ~$480/month
- Hosting: ~$20-50/month
- **Total: $500-530/month**

### Revenue to Break Even

If charging $9/month for Pro tier:
- Need ~6 paying users to break even at medium traffic
- Need ~56 paying users to break even at high traffic

## Performance Optimization

### 1. Caching Strategy

Cache generated websites to reduce API calls:

```javascript
// Simple localStorage cache
const cacheKey = hashResumeContent(resumeContent);
const cached = localStorage.getItem(cacheKey);

if (cached) {
  return JSON.parse(cached);
}

// Generate new, then cache
const result = await generateWebsite(resumeContent);
localStorage.setItem(cacheKey, JSON.stringify(result));
```

### 2. Rate Limiting

Prevent abuse:

```javascript
// Simple rate limit (client-side)
const RATE_LIMIT = 3; // 3 requests per hour
const WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit() {
  const now = Date.now();
  const requests = JSON.parse(localStorage.getItem('requests') || '[]');
  
  const recentRequests = requests.filter(time => now - time < WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT) {
    throw new Error('Rate limit exceeded');
  }
  
  recentRequests.push(now);
  localStorage.setItem('requests', JSON.stringify(recentRequests));
}
```

### 3. Compression

Compress generated HTML:

```javascript
// Use pako for gzip compression
const compressed = pako.gzip(htmlContent);
const base64 = btoa(String.fromCharCode.apply(null, compressed));
```

## Security Checklist

- [ ] API key not exposed in client-side code
- [ ] File upload validation (type, size)
- [ ] Content sanitization (prevent XSS)
- [ ] Rate limiting implemented
- [ ] HTTPS enabled
- [ ] CORS configured correctly
- [ ] CSP headers added
- [ ] Input validation on all forms
- [ ] Error messages don't leak sensitive info
- [ ] Logging doesn't include PII

## Monitoring & Analytics

### Google Analytics Setup

Add to your HTML:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

### Key Events to Track

```javascript
// Track generation success
gtag('event', 'website_generated', {
  'template': selectedTemplate,
  'file_type': fileType,
  'generation_time': timeTaken
});

// Track downloads
gtag('event', 'download', {
  'file_type': 'html'
});

// Track errors
gtag('event', 'error', {
  'error_type': errorType,
  'error_message': message
});
```

## Backup & Recovery

### Backup Strategy

1. **User Data**: Store in database with daily backups
2. **Generated Websites**: Cache in Redis/CDN
3. **Code**: Use Git with remote repository
4. **Configuration**: Document all env variables

### Disaster Recovery Plan

1. Keep production database backups
2. Document deployment process
3. Have staging environment
4. Maintain changelog
5. Version all releases

## Support & Maintenance

### Weekly Tasks
- [ ] Review error logs
- [ ] Check API usage and costs
- [ ] Monitor user feedback
- [ ] Update dependencies

### Monthly Tasks
- [ ] Security audit
- [ ] Performance review
- [ ] User satisfaction survey
- [ ] Cost optimization review

### Quarterly Tasks
- [ ] Major feature updates
- [ ] Design refresh
- [ ] Marketing campaigns
- [ ] Competitor analysis

---

## Quick Reference

### Important Links
- Anthropic Console: https://console.anthropic.com/
- Anthropic Docs: https://docs.anthropic.com/
- Claude API Pricing: https://www.anthropic.com/pricing

### Support Contacts
- API Issues: support@anthropic.com
- Documentation: https://docs.anthropic.com/

### Useful Resources
- HTML Validator: https://validator.w3.org/
- Lighthouse (Performance): Chrome DevTools
- Font Pairs: https://fontpair.co/
- Color Schemes: https://coolors.co/

---

**Remember**: Start simple, iterate based on user feedback, and scale gradually!