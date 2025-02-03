(function($) {
    /**
     * Identity shader
     */
    $.WebGLModule.IdentityLayer = class extends $.WebGLModule.ShaderLayer {

        static type() {
            return "identity";
        }

        static name() {
            return "Identity";
        }

        static description() {
            return "shows the data AS-IS";
        }

        static sources() {
            return [{
                acceptsChannelCount: (x) => x === 4,
                description: "4d texture to render AS-IS"
            }];
        }

        getFragmentShaderExecution() {
            return `
        return ${this.sampleChannel("v_texture_coords")};`;
        }
    };

    $.WebGLModule.IdentityLayer.defaultControls["use_channel0"] = {
        required: "rgba"
    };

    $.WebGLModule.ShaderMediator.registerLayer($.WebGLModule.IdentityLayer);

})(OpenSeadragon);
