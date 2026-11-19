-- FakyTime does all of its work in the Steam UI (frontend/).
-- The backend only exists because Millennium plugins need one to report "ready".
local logger     = require("logger")
local millennium = require("millennium")

local function on_load()
    logger:info("FakyTime loaded (Millennium " .. millennium.version() .. ")")
    millennium.ready()
end

local function on_unload()
    logger:info("FakyTime unloaded")
end

local function on_frontend_loaded()
    logger:info("FakyTime frontend attached")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
