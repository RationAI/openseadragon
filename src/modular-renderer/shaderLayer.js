(function($) {
    /**
     * Organizer of ShaderLayers.
     *
     * @property {object} _layers           storage of ShaderLayers, {ShaderLayer.type(): ShaderLayer}
     * @property {Boolean} _acceptsShaders  allow new ShaderLayer registrations
     *
     * @class OpenSeadragon.WebGLModule.ShaderMediator
     * @memberOf OpenSeadragon.WebGLModule
     */
    $.WebGLModule.ShaderMediator = class {
        /**
         * Register ShaderLayer.
         * @param {typeof OpenSeadragon.WebGLModule.ShaderLayer} shaderLayer
         */
        static registerLayer(shaderLayer) {
            if (this._acceptsShaders) {
                if (this._layers[shaderLayer.type()]) {
                    console.warn(`OpenSeadragon.WebGLModule.ShaderMediator::registerLayer: ShaderLayer ${shaderLayer.type()} already registered, overwriting the content!`);
                }
                this._layers[shaderLayer.type()] = shaderLayer;
            } else {
                console.warn("OpenSeadragon.WebGLModule.ShaderMediator::registerLayer: ShaderMediator is set to not accept new ShaderLayers!");
            }
        }

        /**
         * Enable or disable ShaderLayer registrations.
         * @param {Boolean} accepts
         */
        static setAcceptsRegistrations(accepts) {
            if (accepts === true || accepts === false) {
                this._acceptsShaders = accepts;
            } else {
                console.warn("OpenSeadragon.WebGLModule.ShaderMediator::setAcceptsRegistrations: Accepts parameter must be either true or false!");
            }
        }

        /**
         * Get the ShaderLayer implementation.
         * @param {String} shaderType equals to a wanted ShaderLayers.type()'s return value
         * @return {typeof OpenSeadragon.WebGLModule.ShaderLayer}
         */
        static getClass(shaderType) {
            return this._layers[shaderType];
        }

        /**
         * Get all available ShaderLayers.
         * @return {[typeof OpenSeadragon.WebGLModule.ShaderLayer]}
         */
        static availableShaders() {
            return Object.values(this._layers);
        }

        /**
         * Get all available ShaderLayer types.
         * @return {[String]}
         */
        static availableTypes() {
            return Object.keys(this._layers);
        }
    };
    // STATIC PROPERTIES
    $.WebGLModule.ShaderMediator._acceptsShaders = true;
    $.WebGLModule.ShaderMediator._layers = {};



    /**
     * Interface for classes that implement any rendering logic and are part of the final WebGLProgram.
     *
     * @property {Object} defaultControls default controls for the ShaderLayer
     * @property {Object} customParams
     * @property {Object} modes
     * @property {Object} filters
     * @property {Object} filterNames
     * @property {Object} __globalIncludes
     *
     * @interface OpenSeadragon.WebGLModule.ShaderLayer
     * @memberOf OpenSeadragon.WebGLModule
     */
    $.WebGLModule.ShaderLayer = class {
        /**
         * @typedef channelSettings
         * @type {Object}
         * @property {Function} acceptsChannelCount
         * @property {String} description
         */

        /**
         * @param {String} id unique identifier
         * @param {Object} privateOptions
         * @param {Object} privateOptions.shaderConfig              object bind with this ShaderLayer
         * @param {WebGLImplementation} privateOptions.webglContext
         * @param {Object} privateOptions.controls
         * @param {Boolean} privateOptions.interactive
         * @param {Object} privateOptions.cache
         *
         * @param {Function} privateOptions.invalidate  // callback to re-render the viewport
         * @param {Function} privateOptions.rebuild     // callback to rebuild the WebGL program
         * @param {Function} privateOptions.refetch     // callback to reinitialize the whole WebGLDrawer; NOT USED
         *
         * @constructor
         * @memberOf WebGLModule.ShaderLayer
         */
        constructor(id, privateOptions) {
            // unique identifier of this ShaderLayer for WebGLModule
            this.id = id;
            // unique identifier of this ShaderLayer for WebGLProgram
            this.uid = this.constructor.type().replaceAll('-', '_') + '_' + id;
            if (!$.WebGLModule.idPattern.test(this.uid)) {
                console.error(`Invalid ID for the shader: ${id} does not match to the pattern`, $.WebGLModule.idPattern);
            }

            this.__shaderConfig = privateOptions.shaderConfig;
            this.webglContext = privateOptions.webglContext;
            this._controls = privateOptions.controls ? privateOptions.controls : {};
            this._hasInteractiveControls = privateOptions.interactive;
            this._cache = privateOptions.cache ? privateOptions.cache : {};
            this._customControls = privateOptions.params ? privateOptions.params : {};

            this.invalidate = privateOptions.invalidate;
            this._rebuild = privateOptions.rebuild;
            this._refetch = privateOptions.refetch;


            // channels used for sampling data from the texture
            this.__channels = null;
            // which blend mode is being used
            this._mode = null;
            // parameters used for applying filters
            this.__scalePrefix = null;
            this.__scaleSuffix = null;
        }

        /**
         * Manuall constructor for ShaderLayer. Keeped for backward compatibility.
         */
        construct() {
            // set up the color channel(s) for texture sampling
            this.resetChannel(this._customControls);
            // set up the blending mode
            this.resetMode(this._customControls);
            // set up the filters to be applied to sampled data from the texture
            this.resetFilters(this._customControls);
            // build the ShaderLayer's controls
            this._buildControls();
        }

        // STATIC METHODS
        /**
         * Parses value to a float string representation with given precision (length after decimal)
         * @param {number} value value to convert
         * @param {number} defaultValue default value on failure
         * @param {number} precisionLen number of decimals
         * @return {string}
         */
        static toShaderFloatString(value, defaultValue, precisionLen = 5) {
            if (!Number.isInteger(precisionLen) || precisionLen < 0 || precisionLen > 9) {
                precisionLen = 5;
            }
            try {
                return value.toFixed(precisionLen);
            } catch (e) {
                return defaultValue.toFixed(precisionLen);
            }
        }

        // METHODS TO (re)IMPLEMENT WHEN EXTENDING
        /**
         * @returns {String} key under which is the shader registered, should be unique!
         */
        static type() {
            throw "ShaderLayer::type() must be implemented!";
        }

        /**
         * @returns {String} name of the ShaderLayer (user-friendly)
         */
        static name() {
            throw "ShaderLayer::name() must be implemented!";
        }

        /**
         * @returns {String} optional description
         */
        static description() {
            return "No description of the ShaderLayer.";
        }

        /**
         * Declare the object for channel settings. One for each data source (NOT USED, ALWAYS RETURNS ARRAY OF ONE OBJECT; for backward compatibility the array is returned)
         * @returns {[channelSettings]}
         */
        static sources() {
            throw "ShaderLayer::sources() must be implemented!";
        }

        /**
         * Code executed to create the output color. The code
         * must always return a vec4 value, otherwise the program
         * will fail to compile (this code actually runs inside a glsl vec4 function() {...here...}).
         *
         * DO NOT SAMPLE TEXTURE MANUALLY: use this.sampleChannel(...) to generate the sampling code
         *
         * @return {string}
         */
        getFragmentShaderExecution() {
            throw "ShaderLayer::getFragmentShaderExecution must be implemented!";
        }

        /**
         * Code placed outside fragment shader's main function.
         * By default, it includes all definitions of controls defined in this.defaultControls.
         *
         * ANY VARIABLE NAME USED IN THIS FUNCTION MUST CONTAIN UNIQUE ID: this.uid
         * DO NOT SAMPLE TEXTURE MANUALLY: use this.sampleChannel(...) to generate the sampling code
         * WHEN OVERRIDING, INCLUDE THE OUTPUT OF THIS METHOD AT THE BEGINNING OF THE NEW OUTPUT.
         *
         * @return {string} glsl code
         */
        getFragmentShaderDefinition() {
            let glsl = [this.getModeFunction()];

            if (this.usesCustomBlendFunction()) {
                glsl.push(this.getCustomBlendFunction());
            }

            for (const controlName in this._controls) {
                let code = this[controlName].define();
                if (code) {
                    // trim removes whitespace from beggining and the end of the string
                    glsl.push(code.trim());
                }
            }

            // map adds tabs to glsl code lines to make them properly aligned with the rest of the WebGL shader,
            // join puts them all together, separating them with newlines
            let retval = glsl.map((glLine) => "    " + glLine).join("\n");
            return retval;
        }



        // CONTROLs LOGIC
        /**
         * Build the ShaderLayer's controls.
         */
        _buildControls() {
            const defaultControls = this.constructor.defaultControls;

            // add opacity control manually to every ShaderLayer; if not already defined
            if (defaultControls.opacity === undefined || (typeof defaultControls.opacity === "object" && !defaultControls.opacity.accepts("float"))) {
                defaultControls.opacity = {
                    default: {type: "range", default: 1, min: 0, max: 1, step: 0.1, title: "Opacity: "},
                    accepts: (type, instance) => type === "float"
                };
            }

            for (let controlName in defaultControls) {
                // with use_ prefix are defined not UI controls but filters, blend modes, etc.
                if (controlName.startsWith("use_")) {
                    continue;
                }

                // control is manually disabled
                const controlConfig = defaultControls[controlName];
                if (controlConfig === false) {
                    continue;
                }

                const control = $.WebGLModule.UIControls.build(this, controlName, controlConfig, this.id + '_' + controlName, this._customControls[controlName]);
                // enables iterating over the owned controls
                this._controls[controlName] = control;
                // simplify usage of controls (e.g. this.opacity instead of this._controls.opacity)
                this[controlName] = control;
            }
        }

        /**
         * Remove all ShaderLayer's controls.
         */
        removeControls() {
            for (const controlName in this._controls) {
                this.removeControl(controlName);
            }
        }

        /**
         * @param {String} controlName name of the control to remove
         */
        removeControl(controlName) {
            if (!this._controls[controlName]) {
                return;
            }
            delete this._controls[controlName];
            delete this[controlName];
        }

        /**
         * Initialize the ShaderLayer's controls.
         */
        init() {
            for (const controlName in this._controls) {
                const control = this[controlName];
                control.init();
            }
        }

        /**
         * Get HTML code of the ShaderLayer's controls.
         * @returns {String} HTML code
         */
        htmlControls() {
            const controlsHtmls = [];
            for (const controlName in this._controls) {
                const control = this[controlName];
                controlsHtmls.push(control.toHtml(true));
            }
            return controlsHtmls.join("");
        }



        // GLSL LOGIC (getFragmentShaderDefinition and getFragmentShaderExecution could also have been placed in this section)
        /**
         * Called from the the WebGLImplementation's loadProgram function.
         * For every control owned by this ShaderLayer connect control.glLocation attribute to it's corresponding glsl variable.
         * @param {WebGLProgram} program
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         */
        glLoaded(program, gl) {
            for (const controlName in this._controls) {
                this[controlName].glLoaded(program, gl);
            }
        }

        /**
         * Called from the the WebGLImplementation's useProgram function.
         * For every control owned by this ShaderLayer fill it's corresponding glsl variable.
         * @param {WebGLProgram} program WebglProgram instance
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl WebGL Context
         */
        glDrawing(program, gl) {
            for (const controlName in this._controls) {
                this[controlName].glDrawing(program, gl);
            }
        }

        /**
         * Include GLSL shader code on global scope (e.g. define function that is repeatedly used).
         * @param {String} key a key under which is the code stored
         * @param {String} code GLSL code to add to the WebGL shader
         */
        includeGlobalCode(key, code) {
            const container = this.constructor.__globalIncludes;
            if (container[key]) {
                console.warn('$.WebGLModule.ShaderLayer::includeGlobalCode: Global code with key', key, 'already exists in this.__globalIncludes. Overwriting the content!');
            }
            container[key] = code;
        }



        // CACHE LOGIC
        /**
         * Load value from the cache, return default value if not found.
         *
         * @param {String} name
         * @param {String} defaultValue
         * @return {String}
         */
        loadProperty(name, defaultValue) {
            const value = this._cache[name];
            return value !== undefined ? value : defaultValue;
        }

        /**
         * Store value in the cache.
         * @param {String} name
         * @param {String} value
         */
        storeProperty(name, value) {
            this._cache[name] = value;
        }



        // TEXTURE SAMPLING LOGIC
        /**
         * Set color channel(s) for texture sampling.
         * @param {Object} options
         * @param {String} options.use_channel[X] "r", "g" or "b" channel to sample index X, default "r"
         */
        resetChannel(options = {}) {
            if (Object.keys(options) === 0) {
                options = this._customControls;
            }

            // regex to compare with value used with use_channel, to check its correctness
            const channelPattern = new RegExp('[rgba]{1,4}');
            const parseChannel = (controlName, def, sourceDef) => {
                const predefined = this.constructor.defaultControls[controlName];

                if (options[controlName] || predefined) {
                    let channel = predefined ? (predefined.required ? predefined.required : predefined.default) : undefined;
                    if (!channel) {
                        channel = this.loadProperty(controlName, options[controlName]);
                    }

                    // (if channel is not defined) or (is defined and not string) or (is string and doesn't contain __channelPattern)
                    if (!channel || typeof channel !== "string" || channelPattern.exec(channel) === null) {
                        console.warn(`Invalid channel '${controlName}'. Will use channel '${def}'.`, channel, options);
                        this.storeProperty(controlName, def);
                        channel = def;
                    }

                    if (!sourceDef.acceptsChannelCount(channel.length)) {
                        throw `${this.constructor.name()} does not support channel length ${channel.length} for channel: ${channel}`;
                    }

                    if (channel !== options[controlName]) {
                        this.storeProperty(controlName, channel);
                    }
                    return channel;
                }
                return def;
            };

            this.__channels = this.constructor.sources().map((source, i) => parseChannel(`use_channel${i}`, "r", source));
        }

        /**
         * Method for texture sampling with applied channel restrictions and filters.
         *
         * @param {String} textureCoords valid GLSL vec2 object
         * @param {Number} otherDataIndex UNUSED; index of the data source, for backward compatibility left here
         * @param {Boolean} raw whether to output raw value from the texture (do not apply filters)
         *
         * @return {String} glsl code for correct texture sampling within the ShaderLayer's methods for generating glsl code (e.g. getFragmentShaderExecution)
         */
        sampleChannel(textureCoords, otherDataIndex = 0, raw = false) {
            const chan = this.__channels[otherDataIndex];
            let sampled = `${this.webglContext.sampleTexture(otherDataIndex, textureCoords)}.${chan}`;

            if (raw) {
                return sampled;
            }
            return this.filter(sampled);
        }



        // BLENDING LOGIC
        /**
         * Set blending mode.
         * @param {Object} options
         * @param {String} options.use_mode blending mode to use: "show" or "mask" or "mask_clip"
         */
        resetMode(options = {}) {
            if (Object.keys(options) === 0) {
                options = this._customControls;
            }

            const predefined = this.constructor.defaultControls.use_mode;
            // if required, set mode to required
            this._mode = predefined && predefined.required;

            if (!this._mode) {
                if (options.use_mode) {
                    // firstly try to load from cache, if not in cache, use options.use_mode
                    if (!this._mode) {
                        this._mode = this.loadProperty("use_mode", options.use_mode);
                    }

                    // if mode was not in the cache and we got default value = options.use_mode, store it in the cache
                    if (this._mode === options.use_mode) {
                        this.storeProperty("use_mode", this._mode);
                    }
                } else {
                    this._mode = (predefined && predefined.default) || "show";
                }
            }
        }

        /**
         * @returns {Boolean} true if the ShaderLayer has own blend function, false otherwise
         */
        usesCustomBlendFunction() {
            return this._mode !== "show";
        }

        /**
         * @returns {String} GLSL code of the custom blend function
         */
        getCustomBlendFunction() {
            return `vec4 ${this.uid}_blend_func(vec4 fg, vec4 bg) {
        return fg;
    }`;
        }

        /**
         * @returns {String} GLSL code of the ShaderLayer's blend mode's logic
         */
        getModeFunction() {
            let modeDefinition = `void ${this.uid}_blend_mode(vec4 color) {`;
            if (this._mode === "show") {
                modeDefinition += `
        // blend last_color with overall_color using blend_func of the last shader using deffered blending
        deffered_blend();
        last_color = color;
        // switch case -2 = predefined "premultiplied alpha blending"
        last_blend_func_id = -2;
    }`;
            }
            else if (this._mode === "mask") {
                modeDefinition += `
        // blend last_color with overall_color using blend_func of the last shader using deffered blending
        deffered_blend();
        last_color = color;
        // switch case pointing to this.getCustomBlendFunction() code
        last_blend_func_id = ${this.webglContext.getShaderLayerGLSLIndex(this.uid)};
    }`;
            } else if (this._mode === "mask_clip") {
                modeDefinition += `
        last_color = ${this.uid}_blend_func(color, last_color);
    }`;
            }

            return modeDefinition;
        }



        // FILTERS LOGIC
        /**
         * Set filters for a ShaderLayer.
         * @param {Object} options contains filters to apply, currently supported are "use_gamma", "use_exposure", "use_logscale"
         */
        resetFilters(options = {}) {
            if (Object.keys(options) === 0) {
                options = this._customControls;
            }

            this.__scalePrefix = [];
            this.__scaleSuffix = [];
            for (let key in this.constructor.filters) {
                const predefined = this.constructor.defaultControls[key];
                let value = predefined ? predefined.required : undefined;
                if (value === undefined) {
                    if (options[key]) {
                        value = this.loadProperty(key, options[key]);
                    }
                    else {
                        value = predefined ? predefined.default : undefined;
                    }
                }

                if (value !== undefined) {
                    let filter = this.constructor.filters[key](value);
                    this.__scalePrefix.push(filter[0]);
                    this.__scaleSuffix.push(filter[1]);
                }
            }
            this.__scalePrefix = this.__scalePrefix.join("");
            this.__scaleSuffix = this.__scaleSuffix.reverse().join("");
        }

        /**
         * Apply global filters on value
         * @param {String} value GLSL code string, value to filter
         * @return {String} filtered value (GLSL oneliner without ';')
         */
        filter(value) {
            return `${this.__scalePrefix}${value}${this.__scaleSuffix}`;
        }

        /**
         * Set filter value
         * @param filter filter name
         * @param value value of the filter
         */
        setFilterValue(filter, value) {
            if (!this.constructor.filterNames[filter]) {
                console.error("Invalid filter name", filter);
                return;
            }
            this.storeProperty(filter, value);
        }

        /**
         * Get the filter value (alias for loadProperty(...)
         * @param {String} filter filter to read the value of
         * @param {String} defaultValue
         * @return {String} stored filter value or defaultValue if no value available
         */
        getFilterValue(filter, defaultValue) {
            return this.loadProperty(filter, defaultValue);
        }



        // UTILITIES
        /**
         * Evaluates option flag, e.g. any value that indicates boolean 'true'
         * @param {*} value value to interpret
         * @return {Boolean} true if the value is considered boolean 'true'
         */
        isFlag(value) {
            return value === "1" || value === true || value === "true";
        }

        isFlagOrMissing(value) {
            return value === undefined || this.isFlag(value);
        }

        /**
         * Parses value to a float string representation with given precision (length after decimal)
         * @param {Number} value value to convert
         * @param {Number} defaultValue default value on failure
         * @param {Number} precisionLen number of decimals
         * @return {String}
         */
        toShaderFloatString(value, defaultValue, precisionLen = 5) {
            return this.constructor.toShaderFloatString(value, defaultValue, precisionLen);
        }

        /**
         * Get the blend mode.
         * @return {String}
         */
        get mode() {
            return this._mode;
        }

        /**
         * Returns number of textures available to this ShaderLayer.
         * @return {Number} number of textures available
         */
        get texturesCount() {
            return 1;
        }
    };

    /**
     * Declare supported controls by a particular shader,
     * each control defined this way is automatically created for the shader.
     *
     * Structure:
     * shaderLayer.defaultControls = {
     *     controlName: {
                   default: {type: <>, title: <>, default: <>, interactive: true|false, ...},
                   accepts: (type, instance) => <>,
                   required: {type: <>, ...} [OPTIONAL]
     *     }, ...
     * }
     *
     * use: controlId: false to disable a specific control (e.g. all shaders
     *  support opacity by default - use to remove this feature)
     *
     *
     * Additionally, use_[...] value can be specified, such controls enable shader
     * to specify default or required values for built-in use_[...] params. Example:
     * {
     *     use_channel0: {
     *         default: "bg"
     *     },
     *     use_channel1: {
     *         required: "rg"
     *     },
     *     use_gamma: {
     *         default: 0.5
     *     }
     * }
     * reads by default for texture 1 channels 'bg', second texture is always forced to read 'rg',
     * textures apply gamma filter with 0.5 by default if not overridden
     * todo: allow also custom object without structure being specified (use in custom manner,
     *  but limited in automated docs --> require field that summarises its usage)
     *
     * @member {object}
     */
    $.WebGLModule.ShaderLayer.defaultControls = {
        opacity: {
            default: {type: "range", default: 1, min: 0, max: 1, step: 0.1, title: "Opacity: "},
            accepts: (type, instance) => type === "float"
        }
    };

    /**
     * Declare custom parameters for documentation purposes.
     * Can set default values to provide sensible defaults.
     * Requires only 'usage' parameter describing the use.
     * Unlike controls, these values are not processed in any way.
     * Of course you don't have to define your custom parameters,
     * but then these won't be documented in any nice way. Note that
     * the value can be an object, or a different value (e.g., an array)
     * {
     *     customParamId: {
     *         default: {myItem: 1, myValue: "string" ...}, [OPTIONAL]
     *         usage: "This parameter can be used like this and that.",
     *         required: {type: <> ...} [OPTIONAL]
     *     }, ...
     * }
     * @type {any}
     */
    $.WebGLModule.ShaderLayer.customParams = {};

    /**
     * Parameter to save shaderLayer's functionality that can be shared and reused between ShaderLayer instantions.
     */
    $.WebGLModule.ShaderLayer.__globalIncludes = {};


    //not really modular
    //add your filters here if you want... function that takes parameter (number)
    //and returns prefix and suffix to compute oneliner filter
    //should start as 'use_[name]' for namespace collision avoidance (params object)
    //expression should be wrapped in parenthesses for safety: ["(....(", ")....)"] in the middle the
    // filtered variable will be inserted, notice pow does not need inner brackets since its an argument...
    //note: pow avoided in gamma, not usable on vectors, we use pow(x, y) === exp(y*log(x))
    // TODO: implement filters as shader nodes instead!
    $.WebGLModule.ShaderLayer.filters = {};
    $.WebGLModule.ShaderLayer.filters["use_gamma"] = (x) => ["exp(log(", `) / ${$.WebGLModule.ShaderLayer.toShaderFloatString(x, 1)})`];
    $.WebGLModule.ShaderLayer.filters["use_exposure"] = (x) => ["(1.0 - exp(-(", `)* ${$.WebGLModule.ShaderLayer.toShaderFloatString(x, 1)}))`];
    $.WebGLModule.ShaderLayer.filters["use_logscale"] = (x) => {
        x = $.WebGLModule.ShaderLayer.toShaderFloatString(x, 1);
        return [`((log(${x} + (`, `)) - log(${x})) / (log(${x}+1.0)-log(${x})))`];
    };

    $.WebGLModule.ShaderLayer.filterNames = {};
    $.WebGLModule.ShaderLayer.filterNames["use_gamma"] = "Gamma";
    $.WebGLModule.ShaderLayer.filterNames["use_exposure"] = "Exposure";
    $.WebGLModule.ShaderLayer.filterNames["use_logscale"] = "Logarithmic scale";


    /**
     * Factory Manager for predefined UIControls
     *  - you can manage all your UI control logic within your shader implementation
     *  and not to touch this class at all, but here you will find some most common
     *  or some advanced controls ready to use, simple and powerful
     *  - registering an IComponent implementation (or an UiElement) in the factory results in its support
     *  among all the shaders (given the GLSL type, result of sample(...) matches).
     *  - UiElements are objects to create simple controls quickly and get rid of code duplicity,
     *  for more info @see OpenSeadragon.WebGLModule.UIControls.register()
     * @class OpenSeadragon.WebGLModule.UIControls
     */
    $.WebGLModule.UIControls = class {
        /**
         * Get all available control types
         * @return {string[]} array of available control types
         */
        static types() {
            return Object.keys(this._items).concat(Object.keys(this._impls));
        }

        /**
         * Get an element used to create simple controls, if you want
         * an implementation of the controls themselves (IControl), use build(...) to instantiate
         * @param {string} id type of the control
         * @return {*}
         */
        static getUiElement(id) {
            let ctrl = this._items[id];
            if (!ctrl) {
                console.error("Invalid control: " + id);
                ctrl = this._items["number"];
            }
            return ctrl;
        }

        /**
         * Get an element used to create advanced controls, if you want
         * an implementation of simple controls, use build(...) to instantiate
         * @param {string} id type of the control
         * @return {OpenSeadragon.WebGLModule.UIControls.IControl}
         */
        static getUiClass(id) {
            let ctrl = this._impls[id];
            if (!ctrl) {
                console.error("Invalid control: " + id);
                ctrl = this._impls["colormap"];
            }
            return ctrl;
        }

        /**
         * Build UI control object based on given parameters
         * @param {OpenSeadragon.WebGLModule.ShaderLayer} owner owner of the control, shaderLayer
         * @param {string} controlName name used for the control (eg.: opacity)
         * @param {object} controlObject object from shaderLayer.defaultControls, defines control
         * @param {string} controlId
         * @param {object|*} customParams parameters passed to the control (defined by the control) or set as default value if not object ({})
         * @return {OpenSeadragon.WebGLModule.UIControls.IControl}
         */
        static build(owner, controlName, controlObject, controlId, customParams = {}) {
            let defaultParams = controlObject.default,
                accepts = controlObject.accepts,
                requiredParams = controlObject.required === undefined ? {} : controlObject.required;

            let interactivityEnabled = owner._hasInteractiveControls;

            // if not an object, but a value, make it the default one
            if (!(typeof customParams === 'object')) {
                customParams = {default: customParams};
            }
            //must be false if HTML nodes are not managed
            if (!interactivityEnabled) {
                customParams.interactive = false;
            }

            let originalType = defaultParams.type;

            // merge dP < cP < rP recursively with rP having the biggest overwriting priority, without modifying the original objects
            const params = $.extend(true, {}, defaultParams, customParams, requiredParams);

            if (!this._items[params.type]) {
                const controlType = params.type;

                // if cannot use the new control type, try to use the default one
                if (!this._impls[controlType]) {
                    return this._buildFallback(controlType, originalType, owner, controlName, controlObject, params);
                }

                let cls = new this._impls[controlType](owner, controlName, controlId, params);

                if (accepts(cls.type, cls)) {
                    return cls;
                }

                // cannot built with custom implementation, try to build with a default one
                return this._buildFallback(controlType, originalType, owner, controlName, controlObject, params);

            } else { // control's type (eg.: range/number/...) is defined in this._items
                let intristicComponent = this.getUiElement(params.type);
                let comp = new $.WebGLModule.UIControls.SimpleUIControl(
                    owner, controlName, controlId, params, intristicComponent
                );

                if (accepts(comp.type, comp)) {
                    return comp;
                }
                return this._buildFallback(intristicComponent.glType, originalType,
                    owner, controlName, controlObject, params);
            }
        }

        static _buildFallback(newType, originalType, owner, controlName, controlObject, customParams) {
            //repeated check when building object from type

            customParams.interactive = false;
            if (originalType === newType) { //if default and new equal, fail - recursion will not help
                console.error(`Invalid parameter in shader '${customParams.type}': the parameter could not be built.`);
                return undefined;
            } else { //otherwise try to build with originalType (default)
                customParams.type = originalType;
                console.warn("Incompatible UI control type '" + newType + "': making the input non-interactive.");
                return this.build(owner, controlName, controlObject, customParams);
            }
        }

        /**
         * Register simple UI element by providing necessary object
         * implementation:
         *  { defaults: function() {...}, // object with all default values for all supported parameters
             html: function(uniqueId, params, css="") {...}, //how the HTML UI controls look like
            glUniformFunName: function() {...}, //what function webGL uses to pass this attribute to GPU
            decode: function(fromValue) {...}, //parse value obtained from HTML controls into something
                                                    gl[glUniformFunName()](...) can pass to GPU
            glType: //what's the type of this parameter wrt. GLSL: int? vec3?
        * @param type the identifier under which is this control used: lookup made against params.type
        * @param uiElement the object to register, fulfilling the above-described contract
        */
        static register(type, uiElement) {
            function check(el, prop, desc) {
                if (!el[prop]) {
                    console.warn(`Skipping UI control '${type}' due to '${prop}': missing ${desc}.`);
                    return false;
                }
                return true;
            }

            if (check(uiElement, "defaults", "defaults():object") &&
                check(uiElement, "html", "html(uniqueId, params, css):htmlString") &&
                check(uiElement, "glUniformFunName", "glUniformFunName():string") &&
                check(uiElement, "decode", "decode(encodedValue):<compatible with glType>") &&
                check(uiElement, "normalize", "normalize(value, params):<typeof value>") &&
                check(uiElement, "sample", "sample(value, valueGlType):glslString") &&
                check(uiElement, "glType", "glType:string")
            ) {
                uiElement.prototype.getName = () => type;
                if (this._items[type]) {
                    console.warn("Registering an already existing control component: ", type);
                }
                uiElement["uiType"] = type;
                this._items[type] = uiElement;
            }
        }

        /**
         * Register class as a UI control
         * @param {string} type unique control name / identifier
         * @param {OpenSeadragon.WebGLModule.UIControls.IControl} cls to register, implementation class of the controls
         */
        static registerClass(type, cls) {
            //todo not really possible with syntax checker :/
            // if ($.WebGLModule.UIControls.IControl.isPrototypeOf(cls)) {
                cls.prototype.getName = () => type;

                if (this._items[type]) {
                    console.warn("Registering an already existing control component: ", type);
                }
                cls._uiType = type;
                this._impls[type] = cls;
            // } else {
            //     console.warn(`Skipping UI control '${type}': does not inherit from $.WebGLModule.UIControls.IControl.`);
            // }
        }
    };

    // Definitions of possible controls' types, simple functionalities:
    $.WebGLModule.UIControls._items = {
        number: {
            defaults: function() {
                return {title: "Number", interactive: true, default: 0, min: 0, max: 100, step: 1};
            },
            // returns string corresponding to html code for injection
            html: function(uniqueId, params, css = "") {
                let title = params.title ? `<span> ${params.title}</span>` : "";
                return `${title}<input class="form-control input-sm" style="${css}" min="${params.min}" max="${params.max}"
    step="${params.step}" type="number" id="${uniqueId}">`;
            },
            glUniformFunName: function() {
                return "uniform1f";
            },
            decode: function(fromValue) {
                return Number.parseFloat(fromValue);
            },
            normalize: function(value, params) {
                return (value - params.min) / (params.max - params.min);
            },
            sample: function(name, ratio) {
                return name;
            },
            glType: "float",
            uiType: "number"
        },

        range: {
            defaults: function() {
                return {title: "Range", interactive: true, default: 0, min: 0, max: 100, step: 1};
            },
            html: function(uniqueId, params, css = "") {
                let title = params.title ? `<span> ${params.title}</span>` : "";
                return `${title}<input type="range" style="${css}"
    class="with-direct-input" min="${params.min}" max="${params.max}" step="${params.step}" id="${uniqueId}">`;
            },
            glUniformFunName: function() {
                return "uniform1f";
            },
            decode: function(fromValue) {
                return Number.parseFloat(fromValue);
            },
            normalize: function(value, params) {
                return (value - params.min) / (params.max - params.min);
            },
            sample: function(name, ratio) {
                return name;
            },
            glType: "float",
            uiType: "range"
        },

        color: {
            defaults: function() {
                return { title: "Color", interactive: true, default: "#fff900" };
            },
            html: function(uniqueId, params, css = "") {
                let title = params.title ? `<span> ${params.title}</span>` : "";
                return `${title}<input type="color" id="${uniqueId}" style="${css}" class="form-control input-sm">`;
            },
            glUniformFunName: function() {
                return "uniform3fv";
            },
            decode: function(fromValue) {
                try {
                    let index = fromValue.startsWith("#") ? 1 : 0;
                    return [
                        parseInt(fromValue.slice(index, index + 2), 16) / 255,
                        parseInt(fromValue.slice(index + 2, index + 4), 16) / 255,
                        parseInt(fromValue.slice(index + 4, index + 6), 16) / 255
                    ];
                } catch (e) {
                    return [0, 0, 0];
                }
            },
            normalize: function(value, params) {
                return value;
            },
            sample: function(name, ratio) {
                return name;
            },
            glType: "vec3",
            uiType: "color"
        },

        bool: {
            defaults: function() {
                return { title: "Checkbox", interactive: true, default: true };
            },
            html: function(uniqueId, params, css = "") {
                let title = params.title ? `<span> ${params.title}</span>` : "";
                let value = this.decode(params.default) ? "checked" : "";
                //note a bit dirty, but works :) - we want uniform access to 'value' property of all inputs
                return `${title}<input type="checkbox" style="${css}" id="${uniqueId}" ${value}
    class="form-control input-sm" onchange="this.value=this.checked; return true;">`;
            },
            glUniformFunName: function() {
                return "uniform1i";
            },
            decode: function(fromValue) {
                return fromValue && fromValue !== "false" ? 1 : 0;
            },
            normalize: function(value, params) {
                return value;
            },
            sample: function(name, ratio) {
                return name;
            },
            glType: "bool",
            uiType: "bool"
        }
    };

    // Implementation of UI control classes, complex functionalities.
    $.WebGLModule.UIControls._impls = {
        // e.g.: colormap: $.WebGLModule.UIControls.ColorMap
    };

    /**
     * @interface
     */
    $.WebGLModule.UIControls.IControl = class {

        /**
         * Sets common properties needed to create the controls:
         *  this.context @extends WebGLModule.ShaderLayer - owner context
         *  this.name - name of the parameter for this.context.[load/store]Property(...) call
         *  this.id - unique ID for HTML id attribute, to be able to locate controls in DOM,
         *      created as ${uniq}${name}-${context.uid}
         *  this.webGLVariableName - unique webgl uniform variable name, to not to cause conflicts
         *
         * If extended (class-based definition, see registerCass) children should define constructor as
         *
         * @example
         *   constructor(context, name, webGLVariableName, params) {
         *       super(context, name, webGLVariableName);
         *       ...
         *       //possibly make use of params:
         *       this.params = this.getParams(params);
         *
         *       //now access params:
         *       this.params...
         *   }
         *
         * @param {ShaderLayer} owner shader context owning this control
         * @param {string} name name of the control (key to the params in the shader configuration)
         * @param {string} uniq another element to construct the DOM id from, mostly for compound controls
         */
        constructor(owner, name, id) {
            this.owner = owner;
            this.name = name;
            this.id = id;
            this.webGLVariableName = `${name}_${owner.uid}`;
            this._params = {};
            this.__onchange = {};
        }

        /**
         * Safely sets outer params with extension from 'supports'
         *  - overrides 'supports' values with the correct type (derived from supports or supportsAll)
         *  - sets 'supports' as defaults if not set
         * @param params
         */
        getParams(params) {
            const t = this.constructor.getVarType;
            function mergeSafeType(mask, from, possibleTypes) {
                const to = Object.assign({}, mask);
                Object.keys(from).forEach(key => {
                    const tVal = to[key],
                        fVal = from[key],
                        tType = t(tVal),
                        fType = t(fVal);

                    const typeList = possibleTypes ? possibleTypes[key] : undefined,
                        pTypeList = typeList ? typeList.map(x => t(x)) : [];

                    //our type detector distinguishes arrays and objects
                    if (tVal && fVal && tType === "object" && fType === "object") {
                        to[key] = mergeSafeType(tVal, fVal, typeList);
                    } else if (tVal === undefined || tType === fType || pTypeList.includes(fType)) {
                        to[key] = fVal;
                    } else if (fType === "string") {
                        //try parsing NOTE: parsing from supportsAll is ignored!
                        if (tType === "number") {
                            const parsed = Number.parseFloat(fVal);
                            if (!Number.isNaN(parsed)) {
                                to[key] = parsed;
                            }
                        } else if (tType === "boolean") {
                            const value = fVal.toLowerCase();
                            if (value === "false") {
                                to[key] = false;
                            }
                            if (value === "true") {
                                to[key] = true;
                            }
                        }
                    }
                });
                return to;
            }

            return mergeSafeType(this.supports, params, this.supportsAll);
        }

        /**
         * Safely check certain param value
         * @param value  value to check
         * @param defaultValue default value to return if check fails
         * @param paramName name of the param to check value type against
         * @return {boolean|number|*}
         */
        getSafeParam(value, defaultValue, paramName) {
            const t = this.constructor.getVarType;
            function nest(suppNode, suppAllNode) {
                if (t(suppNode) !== "object") {
                    return [suppNode, suppAllNode];
                }
                if (!suppNode[paramName]) {
                    return [undefined, undefined];
                }
                return nest(suppNode[paramName], suppAllNode ? suppAllNode[paramName] : undefined);
            }
            const param = nest(this.supports, this.supportsAll),
                tParam = t(param[0]);

            if (tParam === "object") {
                console.warn("Parameters should not be stored at object level. No type inspection is done.");
                return true; //no supported inspection
            }
            const tValue = t(value);
            //supported type OR supports all types includes the type
            if (tValue === tParam || (param[1] && param[1].map(t).includes(tValue))) {
                return value;
            }

            if (tValue === "string") {
                //try parsing NOTE: parsing from supportsAll is ignored!
                if (tParam === "number") {
                    const parsed = Number.parseFloat(value);
                    if (!Number.isNaN(parsed)) {
                        return parsed;
                    }
                } else if (tParam === "boolean") {
                    const val = value.toLowerCase();
                    if (val === "false") {
                        return false;
                    }
                    if (val === "true") {
                        return true;
                    }
                }
            }

            return defaultValue;
        }

        /**
         * Uniform behaviour wrt type checking in shaders
         * @param x
         * @return {string}
         */
        static getVarType(x) {
            if (x === undefined) {
                return "undefined";
            }
            if (x === null) {
                return "null";
            }
            return Array.isArray(x) ? "array" : typeof x;
        }

        /**
         * JavaScript initialization
         *  - read/store default properties here using this.context.[load/store]Property(...)
         *  - work with own HTML elements already attached to the DOM
         *      - set change listeners, input values!
         */
        init() {
            throw "WebGLModule.UIControls.IControl::init() must be implemented.";
        }

        /**
         * TODO: improve overall setter API
         * Allows to set the control value programatically.
         * Does not trigger canvas re-rednreing, must be done manually (e.g. control.context.invalidate())
         * @param encodedValue any value the given control can support, encoded
         *  (e.g. as the control acts on the GUI - for input number of
         *    values between 5 and 42, the value can be '6' or 6 or 6.15
         */
        set(encodedValue) {
            throw "WebGLModule.UIControls.IControl::set() must be implemented.";
        }

        /**
         * Called when an image is rendered
         * @param {WebGLProgram} program
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         */
        glDrawing(program, gl) {
            //the control should send something to GPU
            throw "WebGLModule.UIControls.IControl::glDrawing() must be implemented.";
        }

        /**
         * Called when associated webgl program is switched to
         * @param {WebGLProgram} program
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         */
        glLoaded(program, gl) {
            //the control should send something to GPU
            throw "WebGLModule.UIControls.IControl::glLoaded() must be implemented.";
        }

        /**
         * Get the UI HTML controls
         *  - these can be referenced in this.init(...)
         *  - should respect this.params.interactive attribute and return non-interactive output if interactive=false
         *      - don't forget to no to work with DOM elements in init(...) in this case
         *
         * todo: when overrided value before 'init' call on params, toHtml was already called, changes might not get propagated
         *  - either: delay toHtml to trigger insertion later (not nice)
         *  - do not allow changes before init call, these changes must happen at constructor
         */
        toHtml(breakLine = true, controlCss = "") {
            throw "WebGLModule.UIControls.IControl::toHtml() must be implemented.";
        }

        /**
         * Handles how the variable is being defined in GLSL
         *  - should use variable names derived from this.webGLVariableName
         */
        define() {
            throw "WebGLModule.UIControls.IControl::define() must be implemented.";
        }

        /**
         * Sample the parameter using ratio as interpolation, must be one-liner expression so that GLSL code can write
         *    `vec3 mySampledValue = ${this.color.sample("0.2")};`
         * NOTE: you can define your own global-scope functions to keep one-lined sampling,
         * see this.context.includeGlobalCode(...)
         * @param {(string|undefined)} value openGL value/variable, used in a way that depends on the UI control currently active
         *        (do not pass arguments, i.e. 'undefined' just get that value, note that some inputs might require you do it..)
         * @param {string} valueGlType GLSL type of the value
         * @return {string} valid GLSL oneliner (wihtout ';') for sampling the value, or invalid code (e.g. error message) to signal error
         */
        sample(value = undefined, valueGlType = 'void') {
            throw "WebGLModule.UIControls.IControl::sample() must be implemented.";
        }

        /**
         * Parameters supported by this UI component, must contain at least
         *  - 'interactive' - type bool, enables and disables the control interactivity
         *  (by changing the content available when rendering html)
         *  - 'title' - type string, the control title
         *
         *  Additionally, for compatibility reasons, you should, if possible, define
         *  - 'default' - type any; the default value for the particular control
         * @return {{}} name: default value mapping
         */
        get supports() {
            throw "WebGLModule.UIControls.IControl::supports must be implemented.";
        }

        /**
         * Type definitions for supports. Can return empty object. In case of missing
         * type definitions, the type is derived from the 'supports()' default value type.
         *
         * Each key must be an array of default values for the given key if applicable.
         * This is an _extension_ to the supports() and can be used only for keys that have more
         * than one default type applicable
         * @return {{}}
         */
        get supportsAll() {
            throw "WebGLModule.UIControls.IControl::typeDefs must be implemented.";
        }

        /**
         * GLSL type of this control: what type is returned from this.sample(...) ?
         * @return {string}
         */
        get type() {
            throw "WebGLModule.UIControls.IControl::type must be implemented.";
        }

        /**
         * Raw value sent to the GPU, note that not necessarily typeof raw() === type()
         * some controls might send whole arrays of data (raw) and do smart sampling such that type is only a number
         * @return {any}
         */
        get raw() {
            throw "WebGLModule.UIControls.IControl::raw must be implemented.";
        }

        /**
         * Encoded value as used in the UI, e.g. a name of particular colormap, or array of string values of breaks...
         * @return {any}
         */
        get encoded() {
            throw "WebGLModule.UIControls.IControl::encoded must be implemented.";
        }

        //////////////////////////////////////
        //////// COMMON API //////////////////
        //////////////////////////////////////

        /**
         * The control type component was registered with. Handled internally.
         * @return {*}
         */
        get uiControlType() {
            return this.constructor._uiType;
        }

        /**
         * Get current control parameters
         * the control should set the value as this._params = this.getParams(incomingParams);
         * @return {{}}
         */
        get params() {
            return this._params;
        }

        /**
         * Automatically overridden to return the name of the control it was registered with
         * @return {string}
         */
        getName() {
            return "IControl";
        }

        /**
         * Load a value from cache to support its caching - should be used on all values
         * that are available for the user to play around with and change using UI controls
         *
         * @param defaultValue value to return in case of no cached value
         * @param paramName name of the parameter, must be equal to the name from 'supports' definition
         *  - default value can be empty string
         * @return {*} cached or default value
         */
        load(defaultValue, paramName = "") {
            const value = this.owner.loadProperty(this.name + (paramName === "default" ? "" : paramName), defaultValue);
            return value;
        }

        /**
         * Store a value from cache to support its caching - should be used on all values
         * that are available for the user to play around with and change using UI controls
         *
         * @param value to store
         * @param paramName name of the parameter, must be equal to the name from 'supports' definition
         *  - default value can be empty string
         */
        store(value, paramName = "") {
            if (paramName === "default") {
                paramName = "";
            }
            this.owner.storeProperty(this.name + paramName, value);
        }

        /**
         * On parameter change register self
         * @param {string} event which event to fire on
         *  - events are with inputs the names of supported parameters (this.supports), separated by dot if nested
         *  - most controls support "default" event - change of default value
         *  - see specific control implementation to see what events are fired (Advanced Slider fires "breaks" and "mask" for instance)
         * @param {function} clbck(rawValue, encodedValue, context) call once change occurs, context is the control instance
         */
        on(event, clbck) {
            this.__onchange[event] = clbck; //only one possible event -> rewrite?
        }

        /**
         * Clear events of the event type
         * @param {string} event type
         */
        off(event) {
            delete this.__onchange[event];
        }

        /**
         * Clear ALL events
         */
        clearEvents() {
            this.__onchange = {};
        }

        /**
         * Invoke changed value event
         *  -- should invoke every time a value changes !driven by USER!, and use unique or compatible
         *     event name (event 'value') so that shader knows what changed
         * @param event event to call
         * @param value decoded value of encodedValue
         * @param encodedValue value that was received from the UI input
         * @param context self reference to bind to the callback
         */
        changed(event, value, encodedValue, context) {
            if (typeof this.__onchange[event] === "function") {
                this.__onchange[event](value, encodedValue, context);
            }
        }

        /**
         * Create cache object to store this control's values.
         * @returns {object}
         */
        createCacheObject() {
            this._cache = {
                encodedValue: this.encoded,
                value: this.raw
            };
            return this._cache;
        }

        /**
         *
         * @param {object} cache object to serve as control's cache
         */
        loadCacheObject(cache) {
            this._cache = cache;
            this.set(cache.encodedValue);
        }
    };


    /**
     * Generic UI control implementations
     * used if:
     * {
     *     type: "CONTROL TYPE",
     *     ...
     * }
     *
     * The subclass constructor should get the context reference, the name
     * of the input and the parametrization.
     *
     * Further parameters passed are dependent on the control type, see
     * @ WebGLModule.UIControls
     *
     * @class WebGLModule.UIControls.SimpleUIControl
     */
    $.WebGLModule.UIControls.SimpleUIControl = class extends $.WebGLModule.UIControls.IControl {
        /**
         * Uses intristicComponent from UIControls._items that corresponds to type of this control.
         * @param {ShaderLayer} owner owner of the control (shaderLayer)
         * @param {string} name name of the control (eg. "opacity")
         * @param {string} id unique control's id, corresponds to it's DOM's element's id
         * @param {object} params
         * @param {object} intristicComponent control's object from UIControls._items, keyed with it's params.default.type?
         */
        constructor(owner, name, id, params, intristicComponent) {
            super(owner, name, id);
            this.component = intristicComponent;
            this._params = this.getParams(params);
        }

        /**
         * Set this.encodedValue to the default value defined in the intristicComponent.
         * Set this.value to the normalized value (from the encoded value) that will be sent to the GLSL.
         * Register "change" event handler to the control, if interactive.
         */
        init() {
            this.encodedValue = this.load(this.params.default);
            // nothing was stored in the cache so we got the default value from the load call => store the value in the cache
            if (this.encodedValue === this.params.default) {
                this.store(this.encodedValue);
            }

            /** Firstly decode encodedValue:
             *      for color it means that it is converted from string "#ffffff" to an array of three floats,
             *      for range it just parses the float on input.
             *  Secondly normalize the obtained value:
             *      for color it does nothing,
             *      for range it somehow gets it to the range <0, 1>;
             *          e.g.: with the range-min being 0 and range-max 100 and default value 40, it will set the min to 0, max to 100, and value to 0.4;
             *                  so that "distances" between the value and min and max remain the same.
             */
            this.value = this.component.normalize(this.component.decode(this.encodedValue), this.params);

            if (this.params.interactive) {
                const _this = this;
                let node = document.getElementById(this.id);
                if (node) {
                    let updater = function(e) {
                        _this.set(e.target.value);
                        _this.owner.invalidate();
                    };

                    // TODO: some elements do not have 'value' attribute, but 'checked' or 'selected' instead
                    node.value = this.encodedValue;
                    node.addEventListener('change', updater);
                } else {
                    console.error('$.WebGLModule.UIControls.SimpleUIControl::init: HTML element with id =', this.id, 'not found! Cannot set event listener for the control.');
                }
            }
        }

        set(encodedValue) {
            this.encodedValue = encodedValue;
            this.value = this.component.normalize(this.component.decode(this.encodedValue), this.params);

            this.changed("default", this.value, this.encodedValue, this);
            this.store(this.encodedValue);
        }

        glDrawing(program, gl) {
            // debugging purposes
            // console.debug('Setting', this.component.glUniformFunName(), 'corresponding to', this.webGLVariableName, 'to value', this.value);
            gl[this.component.glUniformFunName()](this.glLocation, this.value);
        }

        glLoaded(program, gl) {
            // debugging purposes
            // console.debug(`Setting control's glLocation to ${this.webGLVariableName}`);
            this.glLocation = gl.getUniformLocation(program, this.webGLVariableName);
        }

        toHtml(breakLine = true, controlCss = "") {
            const result = this.component.html(this.id, this.params, controlCss);
            return breakLine ? `<div>${result}</div>` : result;
        }

        define() {
            return `uniform ${this.component.glType} ${this.webGLVariableName};`;
        }

        sample(value = undefined, valueGlType = 'void') {
            if (!value || valueGlType !== 'float') {
                return this.webGLVariableName;
            }
            return this.component.sample(this.webGLVariableName, value);
        }

        get uiControlType() {
            return this.component["uiType"];
        }

        get supports() {
            return this.component.defaults();
        }

        get supportsAll() {
            return {};
        }

        get raw() {
            return this.value;
        }

        get encoded() {
            return this.encodedValue;
        }

        get type() {
            return this.component.glType;
        }
    };
})(OpenSeadragon);
