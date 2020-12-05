import { on } from './events'
import { routeBuilder, IDependencies } from './route-builder'
import { init } from "./init"
import { mockMiddleware } from "./mock"
import * as I from './interfaces'

export = OpenAPIEnforcerMiddleware

function OpenAPIEnforcerMiddleware (enforcerPromise: Promise<any>) {
    return {
        init (options?: I.MiddlewareOptions): I.Middleware {
            return init(enforcerPromise, options)
        },
        mock () {
            return mockMiddleware()
        },
        on,
        route (controllersDir: string, dependencies?: IDependencies, options?: I.RouteBuilderOptions) {
            return routeBuilder(enforcerPromise, controllersDir, dependencies, options)
        }
    }
}

OpenAPIEnforcerMiddleware.default = OpenAPIEnforcerMiddleware