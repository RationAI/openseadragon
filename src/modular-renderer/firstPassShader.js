(function($) {
    /**
     * Custom first-pass identity "ShaderLayer".
     */
    $.WebGLModule.FirstPassLayer = class {
        static type() {
            return "firstPass";
        }

        static name() {
            return "Custom first-pass identity";
        }

        static description() {
            return "Use to render the data AS-IS into an off-screen texture.";
        }

        getFragmentShaderDefinition() {
            return "";
        }

        getFragmentShaderExecution() {
            return `
        return osd_texture(0, v_texture_coords);`;
        }
    };

    $.WebGLModule.ShaderMediator.registerLayer($.WebGLModule.FirstPassLayer);
})(OpenSeadragon);
