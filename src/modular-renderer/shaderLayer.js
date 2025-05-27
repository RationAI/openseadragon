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
            this._interactive = privateOptions.interactive;
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
         * Declare supported controls by a particular shader,
         * each control defined this way is automatically created for the shader.
         *
         * Structure:
         * get defaultControls () => {
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
         *     },
         * }
         * reads by default for texture 1 channels 'bg', second texture is always forced to read 'rg',
         * textures apply gamma filter with 0.5 by default if not overridden
         * todo: allow also custom object without structure being specified (use in custom manner,
         *  but limited in automated docs --> require field that summarises its usage)
         *
         * @member {object}
         */
        static get defaultControls() {
            return {};
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
            const glsl = [];
            return glsl.join("\n    ");
        }

        /**
         * Initialize the ShaderLayer's controls.
         */
        init() {
        }

        // GLSL LOGIC (getFragmentShaderDefinition and getFragmentShaderExecution could also have been placed in this section)
        /**
         * Called from the the WebGLImplementation's loadProgram function.
         * For every control owned by this ShaderLayer connect control.glLocation attribute to it's corresponding glsl variable.
         * @param {WebGLProgram} program
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
         */
        glLoaded(program, gl) {
        }

        /**
         * Called from the the WebGLImplementation's useProgram function.
         * For every control owned by this ShaderLayer fill it's corresponding glsl variable.
         * @param {WebGLProgram} program WebglProgram instance
         * @param {WebGLRenderingContext|WebGL2RenderingContext} gl WebGL Context
         */
        glDrawing(program, gl) {
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

        /**
         * Called when shader is destructed
         */
        destroy() {
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

        /**
         *
         * @param otherDataIndex
         * @return {never}
         */
        getTextureSize(otherDataIndex = 0) {
            return this.webglContext.getTextureSize(otherDataIndex);
        }


        // BLENDING LOGIC
        /**
         * Set blending mode.
         * @param {Object} options
         * @param {String} options.use_mode blending mode to use: one of supportedUseModes
         */
        resetMode(options = {}) {
            this._mode = this._resetOption("use_mode", this.webglContext.supportedUseModes, options);
            this._blend = this._resetOption("use_blend", OpenSeadragon.WebGLModule.BLEND_MODE, options);
        }

        _resetOption(name, supportedValueList, options = {}) {
            let result;
            if (!options) {
                options = this._customControls;
            }

            const predefined = this.constructor.defaultControls[name];
            // if required, set mode to required
            result = predefined && predefined.required;

            if (!result) {
                if (options[name]) {
                    // firstly try to load from cache, if not in cache, use options.use_mode
                    result = this.loadProperty(name, options[name]);

                    // if mode was not in the cache and we got default value = options.use_mode, store it in the cache
                    if (result === options[name]) {
                        this.storeProperty(name, result);
                    }
                } else {
                    result = (predefined && predefined.default) || supportedValueList[0];
                }
            }

            if (!supportedValueList.includes(result)) {
                $.console.warn(`Invalid ${name}: ${result}. Using default`, supportedValueList[0]);
                return supportedValueList[0];
            }
            return result;
        }

        /**
         * @returns {String} GLSL code of the custom blend function
         * TODO configurable...
         */
        getCustomBlendFunction(functionName) {
            let code = this.webglContext.getBlendingFunction(this._blend);
            if (!code) {
                $.console.warn("Invalid blending - using default", this._blend, this);
                this._blend = 'mask';
                code = this.webglContext.getBlendingFunction(this._blend);
            }
            return `vec4 ${functionName}(vec4 fg, vec4 bg) {
${code}
}`;
        }

        /**
         * Get JSON configuration
         * @return {ShaderConfig}
         */
        getConfig() {
            return this.__shaderConfig;
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
})(OpenSeadragon);
