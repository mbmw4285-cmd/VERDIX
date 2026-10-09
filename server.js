const express = require("express");
const path = require("path");
require("dotenv").config();
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

const state = {
  ai:"Demo mode", esp32:"Not connected", lastClassification:"No item classified yet",
  bins:{Plastic:{fill:null,items:0},Metal:{fill:null,items:0},Organic:{fill:null,items:0},Other:{fill:null,items:0}},
  history:[]
};
app.get("/api/health",(_req,res)=>res.json({project:"VERDIX",status:"online",mode:"starter demo"}));
app.get("/api/status",(_req,res)=>res.json(state));
app.post("/api/classification",(req,res)=>{
  const {category,confidence}=req.body||{};
  if(!Object.hasOwn(state.bins,category)) return res.status(400).json({error:"Use Plastic, Metal, Organic, or Other"});
  const item={category,confidence:Number.isFinite(confidence)?Math.max(0,Math.min(100,confidence)):null,time:new Date().toISOString()};
  state.lastClassification=category; state.history.unshift(item); state.history=state.history.slice(0,20); state.bins[category].items++;
  res.json({ok:true,item});
});
app.post("/api/bins",(req,res)=>{
  const {bin,fill}=req.body||{};
  if(!Object.hasOwn(state.bins,bin)) return res.status(400).json({error:"Unknown bin"});
  const n=Number(fill); if(!Number.isFinite(n)||n<0||n>100) return res.status(400).json({error:"fill must be 0-100"});
  state.bins[bin].fill=n; res.json({ok:true,bin,fill:n});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`VERDIX server running on port ${PORT}`));
