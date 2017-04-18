import React from 'react';
import { Image, ActivityIndicator, NetInfo, Platform } from 'react-native';
import RNFS, { DocumentDirectoryPath } from 'react-native-fs';
import ResponsiveImage from 'react-native-responsive-image';

const SHA1 = require("crypto-js/sha1");
const URL = require('url-parse');

export default
class CacheableImage extends React.Component {

    constructor(props) {
        super(props);
        
        this.imageDownloadBegin = this.imageDownloadBegin.bind(this);
        this.imageDownloadProgress = this.imageDownloadProgress.bind(this);
        this._handleConnectivityChange = this._handleConnectivityChange.bind(this);
        this._stopDownload = this._stopDownload.bind(this);
        
        this.state = {
            isRemote: false,
            cachedImagePath: null,
            cacheable: true
        };

        this.networkAvailable = props.networkAvailable;
        this.downloading = false;
        this.jobId = null;
    };

    componentWillReceiveProps(nextProps) {
        if (nextProps.source != this.props.source || nextProps.networkAvailable != this.networkAvailable) {
            this.networkAvailable = nextProps.networkAvailable;
            this._processSource(nextProps.source);
        }
    }

    shouldComponentUpdate(nextProps, nextState) {
        if (nextState === this.state && nextProps === this.props) {
            return false;
        }
        return true;
    }
    
    setNativeProps(nativeProps) {
        if (this._imageComponent) {
            this._imageComponent.setNativeProps(nativeProps);
        }
    }

    async imageDownloadBegin(info) {
        switch (info.statusCode) {
            case 404:
            case 403:
                break;
            default:
                this.downloading = true;
                this.jobId = info.jobId;
        }
    }

    async imageDownloadProgress(info) {
        if ((info.contentLength / info.bytesWritten) == 1) {
            this.downloading = false;
            this.jobId = null;
        }
    }

    async checkImageCache(imageUri, cachePath, cacheKey) {
        const dirPath = DocumentDirectoryPath+'/'+cachePath;
        const filePath = dirPath+'/'+cacheKey;
        
        RNFS
        .stat(filePath)
        .then((res) => {
            if (res.isFile() && res.size > 0) {
                // It's possible the component has already unmounted before setState could be called. 
                // It happens when the defaultSource and source have both been cached.
                // An attempt is made to display the default however it's instantly removed since source is available
                
                // means file exists, ie, cache-hit
                this.setState({cacheable: true, cachedImagePath: filePath});
            } 
            else {
                throw Error("CacheableImage: Invalid file in checkImageCache()");
            }
        })
        .catch((err) => {

            // means file does not exist
            // first make sure network is available..
            // if (! this.state.networkAvailable) {
            if (! this.networkAvailable) {
                return;
            }

            // then make sure directory exists.. then begin download
            // The NSURLIsExcludedFromBackupKey property can be provided to set this attribute on iOS platforms.
            // Apple will reject apps for storing offline cache data that does not have this attribute.
            // https://github.com/johanneslumpe/react-native-fs#mkdirfilepath-string-options-mkdiroptions-promisevoid
            RNFS
            .mkdir(dirPath, {NSURLIsExcludedFromBackupKey: true})
            .then(() => {

                // before we change the cachedImagePath.. if the previous cachedImagePath was set.. remove it
                if (this.state.cacheable && this.state.cachedImagePath) {
                    let delImagePath = this.state.cachedImagePath;
                    this._deleteFilePath(delImagePath);
                }

                // If already downloading, cancel the job
                if (this.jobId) {
                    this._stopDownload();
                }

                let downloadOptions = {
                    fromUrl: imageUri,
                    toFile: filePath,
                    background: this.props.downloadInBackground,
                    begin: this.imageDownloadBegin,
                    progress: this.imageDownloadProgress
                };

                // directory exists.. begin download
                let download = RNFS
                .downloadFile(downloadOptions);

                this.downloading = true;
                this.jobId = download.jobId;

                download.promise
                .then((res) => {
                    this.downloading = false;
                    this.jobId = null;

                    switch (res.statusCode) {
                        case 404:
                        case 403:
                            this.setState({cacheable: false, cachedImagePath: null});
                            break;
                        default:
                            this.setState({cacheable: true, cachedImagePath: filePath});                
                    }
                })
                .catch((err) => {
                    // error occurred while downloading or download stopped.. remove file if created
                    this._deleteFilePath(filePath);

                    // If there was no in-progress job, it may have been cancelled already (and this component may be unmounted)
                    if (this.downloading) {
                        this.downloading = false;
                        this.jobId = null;
                        this.setState({cacheable: false, cachedImagePath: null});
                    }
                });
            })
            .catch((err) => {
                this._deleteFilePath(filePath);
                this.setState({cacheable: false, cachedImagePath: null});
            });
        });
    }

    _deleteFilePath(filePath) {
        RNFS
        .exists(filePath)
        .then((res) => {
            if (res) {
                RNFS
                .unlink(filePath)
                .catch((err) => {});
            }
        });
    }
    
    _processSource(source, skipSourceCheck) {

        if (this.props.storagePermissionGranted 
            && source !== null
            && source != ''
            && typeof source === "object"
            && source.hasOwnProperty('uri')
            && (
                skipSourceCheck ||
                typeof skipSourceCheck === 'undefined' ||
                (!skipSourceCheck && source != this.props.source)
           )
        )
        { // remote 
            
            if (this.jobId) { // sanity
                this._stopDownload(); 
            }
            
            const url = new URL(source.uri, null, true);

            // handle query params for cache key
            let cacheable = url.pathname;
            if (Array.isArray(this.props.useQueryParamsInCacheKey)) {
                this.props.useQueryParamsInCacheKey.forEach(function(k) {
                    if (url.query.hasOwnProperty(k)) {
                        cacheable = cacheable.concat(url.query[k]);
                    }    
                });                
            }
            else if (this.props.useQueryParamsInCacheKey) {
                cacheable = cacheable.concat(url.query);
            }
        
            const type = url.pathname.replace(/.*\.(.*)/, '$1');
            const cacheKey = SHA1(cacheable) + (type.length < url.pathname.length ? '.' + type : '');

            this.checkImageCache(source.uri, url.host, cacheKey);
            this.setState({isRemote: true});
        }
        else {
            this.setState({isRemote: false});
        }
    }

    _stopDownload() {
        if (!this.jobId) return;

        this.downloading = false;
        RNFS.stopDownload(this.jobId);
        this.jobId = null;
    }

    componentWillMount() {
        if (this.props.checkNetwork) {
            NetInfo.isConnected.addEventListener('change', this._handleConnectivityChange);
            // componentWillUnmount unsets this._handleConnectivityChange in case the component unmounts before this fetch resolves
            NetInfo.isConnected.fetch().done(this._handleConnectivityChange);
        }

        this._processSource(this.props.source, true);
    }

    componentWillUnmount() {
        if (this.props.checkNetwork) {
            NetInfo.isConnected.removeEventListener('change', this._handleConnectivityChange);
            this._handleConnectivityChange = null;
        }
    
        if (this.downloading && this.jobId) {
            this._stopDownload();
        }
    }

    async _handleConnectivityChange(isConnected) {
        this.networkAvailable = isConnected;
        if (this.networkAvailable && this.state.isRemote && !this.state.cachedImagePath) {
            this._processSource(this.props.source);
        }
    };
  
    render() {        
        if ((!this.state.isRemote && !this.props.defaultSource) || !this.props.storagePermissionGranted) {
            return this.renderLocal();
        }

        if (this.state.cacheable && this.state.cachedImagePath) {
            return this.renderCache();
        }
        
        if (this.props.defaultSource) {
            return this.renderDefaultSource();
        }
        
        const { children, defaultSource, checkNetwork, networkAvailable, downloadInBackground, activityIndicatorProps, ...props } = this.props;
        const style = [activityIndicatorProps.style, this.props.style];
        return (
            <ActivityIndicator {...props} {...activityIndicatorProps} style={style} />
        );
    }

    renderCache() {
        const { children, defaultSource, checkNetwork, networkAvailable, downloadInBackground, activityIndicatorProps, ...props } = this.props;
        return (
            <ResponsiveImage {...props} source={{uri: 'file://'+this.state.cachedImagePath}} ref={component => this._imageComponent = component}>
            {children}
            </ResponsiveImage>
        );
    }

    renderLocal() {
        const { children, defaultSource, checkNetwork, networkAvailable, downloadInBackground, activityIndicatorProps, ...props } = this.props;
        return (
            <ResponsiveImage {...props} ref={component => this._imageComponent = component}>
            {children}
            </ResponsiveImage>
        );
    }

    renderDefaultSource() {
        const { children, defaultSource, checkNetwork, networkAvailable, ...props } = this.props;        
        return (
            <CacheableImage {...props} source={defaultSource} checkNetwork={false} networkAvailable={this.networkAvailable} ref={component => this._imageComponent = component}>
            {children}
            </CacheableImage>
        );
    }
}

CacheableImage.propTypes = {
    activityIndicatorProps: React.PropTypes.object,
    defaultSource: Image.propTypes.source,
    useQueryParamsInCacheKey: React.PropTypes.oneOfType([
        React.PropTypes.bool,
        React.PropTypes.array
    ]),
    checkNetwork: React.PropTypes.bool,
    networkAvailable: React.PropTypes.bool,
    downloadInBackground: React.PropTypes.bool,
    storagePermissionGranted: React.PropTypes.bool
};

CacheableImage.defaultProps = {
    style: { backgroundColor: 'transparent' },
    activityIndicatorProps: {
        style: { backgroundColor: 'transparent', flex: 1 }
    },
    useQueryParamsInCacheKey: false, // bc
    checkNetwork: true,
    networkAvailable: false,
    downloadInBackground: (Platform.OS === 'ios') ? false : true,
    storagePermissionGranted: true
};
