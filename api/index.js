const path=require('path');process.chdir(path.join(__dirname,'..'));
process.env.DATA_DIR=process.env.DATA_DIR||'/tmp/data';
require('../server.js');
module.exports=async(req,res)=>{await global.__ready;return global.__app(req,res)};
