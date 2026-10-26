import { onRequestPost as __capsules__id__consume_js_onRequestPost } from "/Users/arshbuttar/projects/spim-site/functions/capsules/[id]/consume.js"
import { onRequestGet as __capsules__id__js_onRequestGet } from "/Users/arshbuttar/projects/spim-site/functions/capsules/[id].js"
import { onRequestGet as __capsules_js_onRequestGet } from "/Users/arshbuttar/projects/spim-site/functions/capsules.js"
import { onRequestOptions as __capsules_js_onRequestOptions } from "/Users/arshbuttar/projects/spim-site/functions/capsules.js"
import { onRequestPost as __capsules_js_onRequestPost } from "/Users/arshbuttar/projects/spim-site/functions/capsules.js"

export const routes = [
    {
      routePath: "/capsules/:id/consume",
      mountPath: "/capsules/:id",
      method: "POST",
      middlewares: [],
      modules: [__capsules__id__consume_js_onRequestPost],
    },
  {
      routePath: "/capsules/:id",
      mountPath: "/capsules",
      method: "GET",
      middlewares: [],
      modules: [__capsules__id__js_onRequestGet],
    },
  {
      routePath: "/capsules",
      mountPath: "/",
      method: "GET",
      middlewares: [],
      modules: [__capsules_js_onRequestGet],
    },
  {
      routePath: "/capsules",
      mountPath: "/",
      method: "OPTIONS",
      middlewares: [],
      modules: [__capsules_js_onRequestOptions],
    },
  {
      routePath: "/capsules",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__capsules_js_onRequestPost],
    },
  ]