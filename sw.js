var CACHE_NAME="xodimlar-monitoring-pwa-v5";
var APP_SHELL=["./","./index.html","./sw.js"];
var LAST_PAGE_KEY="last-successful-page";

function isCacheableResponse(response){
  return !!response&&(response.ok||response.type==="opaque");
}

function isStaticAsset(request){
  var url=new URL(request.url);
  var destination=request.destination||"";
  if(url.origin===self.location.origin){
    return ["document","script","style","font","image","manifest"].indexOf(destination)!==-1;
  }
  return /(?:gstatic|googleapis|unpkg|sheetjs)/i.test(url.hostname)&&["script","style","font","image"].indexOf(destination)!==-1;
}

self.addEventListener("install",function(event){
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache){
        return cache.addAll(APP_SHELL.map(function(path){
          return new Request(path,{cache:"reload"});
        }));
      })
      .catch(function(){})
      .then(function(){
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate",function(event){
  event.waitUntil(
    caches.keys()
      .then(function(keys){
        return Promise.all(
          keys.map(function(key){
            if(key!==CACHE_NAME) return caches.delete(key);
          })
        );
      })
      .then(function(){
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch",function(event){
  var request=event.request;
  if(request.method!=="GET") return;

  var url=new URL(request.url);
  if(/(?:firebaseio|open-meteo)\.com/i.test(url.hostname)) return;

  if(request.mode==="navigate"){
    event.respondWith(
      fetch(request)
        .then(function(response){
          if(isCacheableResponse(response)){
            var copy=response.clone();
            caches.open(CACHE_NAME).then(function(cache){
              cache.put(request,copy);
              cache.put(LAST_PAGE_KEY,response.clone());
            });
          }
          return response;
        })
        .catch(function(){
          return caches.open(CACHE_NAME).then(function(cache){
            return cache.match(request)
              .then(function(match){
                return match||cache.match(LAST_PAGE_KEY)||cache.match("./index.html");
              });
          });
        })
    );
    return;
  }

  if(!isStaticAsset(request)) return;

  event.respondWith(
    caches.match(request).then(function(cached){
      var networkFetch=fetch(request)
        .then(function(response){
          if(isCacheableResponse(response)){
            caches.open(CACHE_NAME).then(function(cache){
              cache.put(request,response.clone());
            });
          }
          return response;
        })
        .catch(function(){
          return cached||new Response("",{status:504,statusText:"Offline"});
        });

      return cached||networkFetch;
    })
  );
});

/* ═══ PUSH NOTIFICATION HANDLER ═══ */
self.addEventListener("notificationclick",function(event){
  event.notification.close();
  var url=event.notification.data&&event.notification.data.url?event.notification.data.url:"/";
  event.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(function(clientList){
      for(var i=0;i<clientList.length;i++){
        if(clientList[i].url.indexOf("davomat-tizimi")!==-1&&"focus" in clientList[i]){
          return clientList[i].focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

/* Show notification from message event (triggered by app) */
self.addEventListener("message",function(event){
  if(event.data&&event.data.type==="SHOW_NOTIFICATION"){
    var d=event.data;
    self.registration.showNotification(d.title,{
      body:d.body,
      icon:d.icon||"/favicon.ico",
      badge:d.badge||"/favicon.ico",
      tag:d.tag||"xodimlar-notif",
      data:{url:d.url||"/"},
      vibrate:[200,100,200],
      requireInteraction:d.requireInteraction||false
    });
  }
});
