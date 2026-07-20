const fs=require("fs"),path=require("path"),crypto=require("crypto");
const file=process.env.DATA_FILE||path.join(__dirname,"data","store.json");
function load(){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return{users:[],sessions:[],orders:[]}}}
const db=load();
function save(){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+".tmp";fs.writeFileSync(temp,JSON.stringify(db,null,2));fs.renameSync(temp,file)}
function passwordHash(password,salt=crypto.randomBytes(16).toString("hex")){return{salt,hash:crypto.scryptSync(password,salt,64).toString("hex")}}
function safeUser(user){return{id:user.id,email:user.email,name:user.name,plan:user.plan||"free",planExpiresAt:user.planExpiresAt||null,createdAt:user.createdAt}}
function createUser({email,password,name}){email=email.trim().toLowerCase();if(db.users.some(u=>u.email===email))throw new Error("该邮箱已经注册");const pass=passwordHash(password);const user={id:crypto.randomUUID(),email,name:(name||"房主").trim().slice(0,12),...pass,plan:"free",planExpiresAt:null,createdAt:Date.now()};db.users.push(user);save();return safeUser(user)}
function login(email,password){const user=db.users.find(u=>u.email===email.trim().toLowerCase());if(!user)return null;const pass=passwordHash(password,user.salt);if(!crypto.timingSafeEqual(Buffer.from(pass.hash,"hex"),Buffer.from(user.hash,"hex")))return null;const token=crypto.randomBytes(32).toString("hex");db.sessions.push({token,userId:user.id,expiresAt:Date.now()+30*864e5});save();return{token,user:safeUser(user)}}
function userByToken(token){const session=db.sessions.find(s=>s.token===token&&s.expiresAt>Date.now());const user=session&&db.users.find(u=>u.id===session.userId);if(!user)return null;if(user.planExpiresAt&&user.planExpiresAt<Date.now()){user.plan="free";user.planExpiresAt=null;save()}return user}
function createOrder(userId,plan){const prices={monthly:990,premium:1990};if(!prices[plan])throw new Error("套餐不存在");const order={id:crypto.randomBytes(8).toString("hex").toUpperCase(),userId,plan,amount:prices[plan],status:"pending",createdAt:Date.now()};db.orders.push(order);save();return order}
function activateOrder(orderId){const order=db.orders.find(o=>o.id===orderId);if(!order)throw new Error("订单不存在");if(order.status!=="paid"){order.status="paid";order.paidAt=Date.now();const user=db.users.find(u=>u.id===order.userId);const base=Math.max(Date.now(),user.planExpiresAt||0);user.plan=order.plan;user.planExpiresAt=base+30*864e5;save()}return order}
module.exports={safeUser,createUser,login,userByToken,createOrder,activateOrder};
