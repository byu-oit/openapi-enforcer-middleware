"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.docsMiddleware = void 0;
function docsMiddleware(enforcerPromise, specUrlPath, serverPort, redocOptions = {}) {
    return function (req, res, next) {
        let title = 'API Documentation';
        enforcerPromise.then(openapi => {
            console.log(openapi.info.title);
            title = openapi.info.title;
            let cleanedStr = (specUrlPath.charAt(0) === '/') ? specUrlPath.substr(1) : specUrlPath;
            res.send(`
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>${title}</title>
    <!-- needed for adaptive design -->
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    
    <!-- I _think_ these are safe to include, since Public Sans is a public font and Ringside shouldn't load on non-BYU sites -->
    <link rel="stylesheet" href="https://cdn.byu.edu/theme-fonts/1.x.x/ringside/fonts.css">
    <link rel="stylesheet" href="https://cdn.byu.edu/theme-fonts/1.x.x/public-sans/fonts.css">

    <!--
    ReDoc doesn't change outer page styles
    -->
    <style>
      body {
        margin: 0;
        padding: 0;
      }
    </style>
  </head>
  <body>
    <div id="redoc-container"></div>
    <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
    <script>
      Redoc.init('http://localhost:${serverPort}/${cleanedStr}', ${JSON.stringify(redocOptions)}, document.getElementById('redoc-container'))
    </script>
  </body>
</html>
      `);
        });
    };
}
exports.docsMiddleware = docsMiddleware;
//# sourceMappingURL=docs.js.map