self.addEventListener("install",function(){
  self.skipWaiting();
});

self.addEventListener("activate",function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch",function(event){
  var request=event.request;
  if(request.method!=="GET") return;

  if(request.mode==="navigate"){
    event.respondWith(
      fetch(request)
        .then(function(response){
          var copy=response.clone();
          caches.open("xodimlar-monitoring-pwa-v1").then(function(cache){
            cache.put("last-successful-page",copy);
          });
          return response;
        })
        .catch(function(){
          return caches.open("xodimlar-monitoring-pwa-v1")
            .then(function(cache){return cache.match("last-successful-page");});
        })
    );
  }
});
