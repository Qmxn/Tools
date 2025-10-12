// 引用链接: https://kelee.one/Resource/JavaScript/Weixin/Weixin_Official_Accounts_remove_ads.js
var obj = JSON.parse($response.body);
obj.advertisement_num = 0;
obj.advertisement_info = [];
delete obj.appid;
$done({body: JSON.stringify(obj)}); 