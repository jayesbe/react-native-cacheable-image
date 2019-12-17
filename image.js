import PropTypes from 'prop-types';
import React from 'react';
import { Image, ActivityIndicator, Platform } from 'react-native';
import RNFS, { DocumentDirectoryPath } from 'react-native-fs';
import ResponsiveImage from 'react-native-responsive-image';

// support RN 0.60
import NetInfo from "@react-native-community/netinfo";

const SHA1 = require("crypto-js/sha1");
const URL = require('url-parse');

export default
class CacheableImage extends React.Component {

    static propTypes = {
        activityIndicatorProps: PropTypes.object,
        defaultSource: Image.propTypes.source,
        useQueryParamsInCacheKey: PropTypes.oneOfType([
            PropTypes.bool,
            PropTypes.array
        ]),
        checkNetwork: PropTypes.bool,
        networkAvailable: PropTypes.bool,
        downloadInBackground: PropTypes.bool,
        storagePermissionGranted: PropTypes.bool
    }

    static defaultProps = {
        style: { backgroundColor: 'transparent' },
        activityIndicatorProps: {
            style: { backgroundColor: 'transparent', flex: 1 }
        },
        useQueryParamsInCacheKey: false, // bc
        checkNetwork: true,
        networkAvailable: false,
        downloadInBackground: (Platform.OS === 'ios') ? false : true,
        storagePermissionGranted: true
    }

    state = {
      isRemote: false,
      cachedImagePath: null,
      cacheable: true
    }

    networkAvailable = this.props.networkAvailable
    
    downloading = false
    
    jobId = null
    
    setNativeProps(nativeProps) {
        if (this._imageComponent) {
            this._imageComponent.setNativeProps(nativeProps);
        }
    }

    imageDownloadBegin = info => {
        switch (info.statusCode) {
            case 404:
            case 403:
                break;
            default:
                this.downloading = true;
                this.jobId = info.jobId;
        }
    }

    imageDownloadProgress = info => {
        if ((info.contentLength / info.bytesWritten) == 1) {
            this.downloading = false;
            this.jobId = null;
        }
    }

    checkImageCache = (imageUri, cachePath, cacheKey) => {
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

    _deleteFilePath = (filePath) => {
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
    
    _processSource = (source, skipSourceCheck) => {

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

    _stopDownload = () => {
        if (!this.jobId) return;

        this.downloading = false;
        RNFS.stopDownload(this.jobId);
        this.jobId = null;
    }

    _handleConnectivityChange = isConnected => {
        this.networkAvailable = isConnected;
        if (this.networkAvailable && this.state.isRemote && !this.state.cachedImagePath) {
            this._processSource(this.props.source);
        }
    }
    
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
    
    componentWillMount() {
        if (this.props.checkNetwork) {
            NetInfo.isConnected.addEventListener('connectionChange', this._handleConnectivityChange);
            // componentWillUnmount unsets this._handleConnectivityChange in case the component unmounts before this fetch resolves
            NetInfo.isConnected.fetch().done(this._handleConnectivityChange);
        }

        this._processSource(this.props.source, true);
    }

    componentWillUnmount() {
        if (this.props.checkNetwork) {
            NetInfo.isConnected.removeEventListener('connectionChange', this._handleConnectivityChange);
            this._handleConnectivityChange = null;
        }
    
        if (this.downloading && this.jobId) {
            this._stopDownload();
        }
    }
      
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
