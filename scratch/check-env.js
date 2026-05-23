console.log("Process GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? "EXISTS (starts with " + process.env.GEMINI_API_KEY.slice(0, 5) + ")" : "UNDEFINED");
console.log("Keys available in process.env:", Object.keys(process.env).filter(k => k.toLowerCase().includes('gemini') || k.toLowerCase().includes('api')));
