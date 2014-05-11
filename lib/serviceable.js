( function() {

		var base = {};

		// Event listener infrastructure
		base.listeners = {};

		base.on = function(aEvent, aCallback) {
			base.listeners[aEvent] = aCallback;
		};

		base.off = function(aEvent) {
			delete base.listeners[aEvent];
		};

		base.trigger = function(aEvent) {
			var tCallback = base.listeners[aEvent];
			if (tCallback) {
				// here there be hacks!
				setTimeout(tCallback, 250);
			} else {
				Ti.API.info("no callback assigned for " + aEvent);
			}
		};

		// Serialization infrastructure
		base.endpoints = {};
		base.l2r = {};
		base.r2l = {};
		base.queued = {};
		base.filters = {};
		base.filters.beforePull = {};
		base.filters.afterPull = {};
		base.filters.beforePush = {};
		base.filters.afterPush = {};
		base.filters.ready = {};

		base.setSerializationStrategy = function(aObj, aOptions) {
			base.endpoints[aObj] = aOptions.endpoint;
			base.l2r[aObj] = aOptions.local;
			base.r2l[aObj] = aOptions.remote;
		};

		// callback function receives two arguments: model, local_id
		base.beforePull = function(aObj, aCallback) {
			base.filters.beforePull[aObj] = aCallback;
		};

		base.afterPull = function(aObj, aCallback) {
			base.filters.afterPull[aObj] = aCallback;
		};

		base.beforePush = function(aObj, aCallback) {
			base.filters.beforePush[aObj] = aCallback;
		};

		base.afterPush = function(aObj, aCallback) {
			base.filters.afterPush[aObj] = aCallback;
		};

		// Ready filters
		base.ready = function(aObj, aStrategy) {
			base.filters.ready[aObj] = aStrategy;
		};

		// OAuth2 Bearer Token interface
		base.refreshBearerToken = function(aOptions) {
			var tUsername = aOptions.username;
			var tPassword = aOptions.password;
			var tSuccess = aOptions.success;
			var tError = aOptions.error;
			var tClient = base.clientFactory();
			tClient.onload = function() {
				var tRsp = JSON.parse(this.responseText);
				if (tRsp.token_type == "bearer") {
					base.bearerToken = tRsp.access_token;
					tSuccess();
				} else {
					tError();
				}
			};
			tClient.onerror = function() {
				Ti.API.error("unable to retrieve bearer token: " + JSON.stringify(this));
				tError();
			};
			tClient.open('POST', base.host + "/oauth/token");
			if (tUsername && tPassword) {
				tClient.send({
					username : tUsername,
					password : tPassword,
					client_id : base.clientId,
					client_secret : base.clientSecret,
					grant_type : 'password'
				});
			} else {
				tClient.send({
					client_id : base.clientId,
					client_secret : base.clientSecret,
					grant_type : 'client_credentials'
				});
			}
		};

		// Sync infrastructure
		base.retrieveJournal = function(aObj) {
			var tClient = base.clientFactory();
			var tSince = Ti.App.Properties.getString(aObj + "sLastUpdated");
			var tEndpoint = base.endpoints[aObj];
			tClient.onload = function() {
				var tRsp = JSON.parse(this.responseText);
				for (var k = 0; k < tRsp.length; k++) {
					var tItem = tRsp[k];
					if (tItem.event == "create" || tItem.event == "update") {
						base.retrieveRemoteObject(aObj, tItem.id);
					} else if (tItem.event == "destroy") {
						base.destroyRemoteObject(aObj, tItem.id);
					}
				}
				Ti.API.info("processed " + tRsp.length + " changes");
			};
			tClient.onerror = function() {
				Ti.API.error("unable to fetch journal for " + aObj + ": " + this.error);
			};
			tClient.open("GET", base.host + base.basePath + "/" + tEndpoint + "/journal.json?since=" + tSince);
			tClient.setRequestHeader("Authorization", "Bearer " + base.bearerToken);
			tClient.send();
		};

		base.retrieveRemoteObject = function(aObj, aId) {
			var tLastUpdated = Ti.App.Properties.getString(aObj + "sLastUpdated");
			var tClient = base.clientFactory();
			var tEndpoint = base.endpoints[aObj];
			var tRemote = base.r2l[aObj];
			var tBeforePull = base.filters.beforePull[aObj];
			var tAfterPull = base.filters.afterPull[aObj];
			tClient.onload = function() {
				var tRsp = JSON.parse(this.responseText);
				var tObjs = Alloy.Collections.instance(aObj);
				tObjs.fetch({
					query : 'select * from ' + aObj + ' where remote_id = ' + aId,
					success : function() {
						var tObj;
						tSubObjs = tObjs.where({
							remote_id : aId
						});
						if (tSubObjs.length > 0) {
							tObj = tSubObjs[0];
						} else {
							tObj = Alloy.createModel(aObj);
						}
						if (tBeforePull) {
							tBeforePull(tObj);
						}
						tObj.save(tRemote(tRsp), {
							success : function() {
								if (tAfterPull) {
									tAfterPull(tObj);
								}
								var tUpdated = tObj.get('updated_at');
								if (new Date(tLastUpdated).getTime() < new Date(tUpdated).getTime()) {
									Ti.App.Properties.setString(aObj + "sLastUpdated", tUpdated);
								}
								Ti.API.info("updated local " + aObj + " with id=" + aId);
							}
						});
					}
				});
			};
			tClient.onerror = function() {
				Ti.API.error("failed to retrieve " + aObj + " with id=" + aId);
			};
			tClient.open("GET", base.host + base.basePath + "/" + tEndpoint + "/" + aId + ".json");
			if (base.bearerToken) {
				tClient.setRequestHeader("Authorization", "Bearer " + base.bearerToken);
			}
			tClient.send();
		};

		base.destroyRemoteObject = function(aObj, aId) {
			Ti.API.info("destroying " + aObj + " remote_id=" + aId);
			var tCollection = Alloy.Collections.instance(aObj);
			tCollection.fetch({
				query : 'select * from ' + aObj + ' where remote_id = ' + aId + ' limit 1',
				success : function() {
					var tObjs = tCollection.where({
						remote_id : aId
					});
					if (tObjs == null || tObjs.length == 0) {
						Ti.API.error("unable to find " + aObj + " with remote_id=" + aId);
						return;
					}
					tObjs[0].destroy({
						wait : true,
						success : function() {
							Ti.API.info("destroyed " + aObj + " with remote_id=" + aId);
						},
						error : function() {
							Ti.API.error("unable to destroy " + aObj + " with remote_id=" + aId);
						}
					});
				}
			});
		};

		base.createLocalObject = function(aObj, aOptions) {
			Ti.API.info("creating " + aObj);
			var tModel = Alloy.createModel(aObj);
			tModel.save({
				push_action : "create"
			}, {
				wait : true,
				success : function() {
					aOptions.success(tModel);
				},
				error : function() {
					aOptions.error();
				}
			});
		};

		base.destroyLocalObject = function(aObj, aId) {
			Ti.API.info("destroying " + aObj + " local_id=" + aId);
			var tCollection = Alloy.Collections.instance(aObj);
			tCollection.fetch({
				query : 'select * from ' + aObj + ' where local_id = ' + aId + ' limit 1',
				success : function() {
					var tObjs = tCollection.where({
						local_id : aId
					});
					if (tObjs == null || tObjs.length == 0) {
						Ti.API.error("unable to find " + aObj + " with local_id=" + aId);
						return;
					}
					if (tObjs[0].get('remote_id') == null) {
						tObjs[0].destroy({
							wait : true,
							success : function() {
								Ti.API.info("destroyed " + aObj + " with local_id=" + aId);
							},
							error : function() {
								Ti.API.error("unable to destroy " + aObj + " with local_id=" + aId);
							}
						});
					} else {
						tObjs[0].save({
							push_action : "destroy"
						}, {
							wait : true,
							success : function() {
								Ti.API.info("marked " + aObj + " with local_id=" + aId + " for destroy");
								queueForPush(aObj);
							},
							error : function() {
								Ti.API.error("unable to destroy " + aObj + " with local_id=" + aId);
							}
						});
					}
				}
			});
		};

		base.updateLocalObject = function(aObj, aId, aOptions) {
			Ti.API.info("updating " + aObj + " local_id=" + aId + " with attrs " + JSON.stringify(aOptions));
			var tCollection = Alloy.Collections.instance(aObj);
			tCollection.fetch({
				query : 'select * from ' + aObj + ' where local_id = ' + aId + ' limit 1',
				success : function() {
					var tObjs = tCollection.where({
						local_id : aId
					});
					if (tObjs == null || tObjs.length == 0) {
						Ti.API.error("unable to find " + aObj + " with local_id=" + aId);
						return;
					}
					if (tObjs[0].get('push_action') == null) {
						aOptions.push_action = "update";
					}
					tObjs[0].save(aOptions, {
						wait : true,
						success : function() {
							Ti.API.info("marked " + aObj + " with local_id=" + aId + " for update");
							queueForPush(aObj);
						},
						error : function() {
							Ti.API.error("unable to update " + aObj + " with local_id=" + aId);
						}
					});
				}
			});
		};

		base.loadNext = function(aObj, aPage) {
			var tClient = base.clientFactory();
			var tSince = Ti.App.Properties.getString(aObj + "sLastUpdated");
			var tEndpoint = base.endpoints[aObj];
			tClient.onload = function() {
				var tObjs = JSON.parse(this.responseText);
				base.update(aObj, tObjs);
				if (tObjs && tObjs.length != 0) {
					base.loadNext(aObj, aPage + 1);
				}
			};
			tClient.onerror = function(e) {
				Ti.API.error("unable to sync " + tEndpoint);
			};
			tClient.open("GET", base.urlHelper(tEndpoint, tSince, aPage));
			if (base.bearerToken) {
				tClient.setRequestHeader("Authorization", "Bearer " + base.bearerToken);
			}
			tClient.send();
			Ti.API.info("loading " + tEndpoint + " since " + tSince);
		};

		base.update = function(aObj, aObjs) {
			if (aObjs == null) {
				return;
			}

			var tSince = Ti.App.Properties.getString(aObj + "sLastUpdated");
			var tLastUpdated = tSince;
			var tEndpoint = base.endpoints[aObj];
			var tStrategy = base.r2l[aObj];

			Ti.API.info("inserting " + tEndpoint + " into local db (" + aObjs.length + ")");

			var tObjs = Alloy.Collections.instance(aObj);
			tObjs.fetch({
				async : false,
				success : function() {
					for (var k = 0, K = aObjs.length; k < K; k++) {
						var obj = aObjs[k];
						if (base.recordOutOfDate(obj))
							continue;
						var tExists = false;
						var tObj = tObjs.where({
						remote_id : obj.id
						})[0];
						if (!( tExists = tObj != null)) {
							tObj = Alloy.createModel(aObj, {
								remote_id : obj.id,
							});
						}
						tObj.save(tStrategy(obj), {
							wait : true,
							success : function() {
								if (!tExists) {
									Ti.API.info("created " + aObj + ": " + JSON.stringify(obj));
								} else {
									Ti.API.info("updated " + aObj + ": " + JSON.stringify(obj));
								}
								if (new Date(tSince).getTime() < new Date(obj.updated_at).getTime()) {
									tLastUpdated = obj.updated_at;
								}
							},
							error : function(e) {
								Ti.API.error("error saving " + aObj + ": " + e);
							}
						});
					}
				}
			});

			Ti.API.info("last " + aObj + " at " + tLastUpdated);
			Ti.App.Properties.setString(aObj + "sLastUpdated", tLastUpdated);

			Ti.API.info("finished inserting " + aObj);
			base.trigger(aObj);
		};

		base.pushUpdates = function(aObj) {
			Ti.API.info("pushing updates for " + aObj);

			var tObjs = Alloy.Collections.instance(aObj);
			var tEndpoint = base.endpoints[aObj];
			var tLocal = base.l2r[aObj];
			var tRemote = base.r2l[aObj];
			var tBeforePush = base.filters.beforePush[aObj];
			var tAfterPush = base.filters.afterPush[aObj];
			var tReady = base.filters.ready[aObj];
			tObjs.fetch({
				async : false,
				success : function() {
					// first create any remote records
					_.each(tObjs.select(function(e) {
						return e.get('push_action') == 'create' && (tReady == null || (tReady && tReady(e) ));
					}), function(e) {
						Ti.API.info("processing " + JSON.stringify(e));
						var tLocalId = e.get('local_id');
						var tClient = base.clientFactory();
						var tPath = base.urlHelper(tEndpoint, null, 0);
						var tParams = toQueryString(tLocal(e));
						Ti.API.info("creating remote " + aObj + ": " + JSON.stringify(tLocal(e)));
						if (tBeforePush) {
							tBeforePush(e, tLocalId);
						}
						tClient.onload = function() {
							var tRsp = JSON.parse(this.responseText);
							var tAttrs = tRemote(tRsp);
							tAttrs.push_action = null;

							e.save(tAttrs, {
								wait : true,
								success : function() {
									Ti.API.info("created remote record " + JSON.stringify(e));

									if (tAfterPush) {
										tAfterPush(e, tLocalId);
									}
									base.trigger(aObj);
								},
								error : function() {
									Ti.API.error("failed to update temporary record");
								}
							});
						};
						tClient.onerror = function() {
							Ti.API.error("unable to create remote " + JSON.stringify(this.responseText));
						};
						tClient.open('POST', tPath + "&" + tParams, false);
						if (base.bearerToken) {
							tClient.setRequestHeader("Authorization", "Bearer " + base.bearerToken);
						}
						tClient.send();
					});

					// update existing records
					_.each(tObjs.select(function(e) {
						return e.get('push_action') == 'update';
					}), function(e) {
						Ti.API.info("processing " + JSON.stringify(e));
						var tClient = base.clientFactory();
						var tPath = base.urlHelper(tEndpoint, null, 0);
						var tParams = toQueryString(tLocal(e));
						tPath = tPath.replace(tEndpoint, tEndpoint + "/" + e.get('remote_id'));
						tClient.onload = function() {
							e.save({
								push_action : null
							}, {
								wait : true,
								success : function() {
									Ti.API.info("updated remote record " + JSON.stringify(e));
									base.trigger(aObj);
								},
								error : function() {
									Ti.API.error("unable to confirm remote record update: " + JSON.stringify(e));
								}
							});
						};
						tClient.onerror = function() {
							Ti.API.error("unable to update remote record " + JSON.stringify(this.responseText));
						};
						tClient.open('PUT', tPath + "&" + tParams, false);
						if (base.bearerToken) {
							tClient.setRequestHeader("Authorization", "Bearer " + base.bearerToken);
						}
						tClient.send();

					});

					// destroy pending records
					_.each(tObjs.select(function(e) {
						return e.get('push_action') == 'destroy';
					}), function(e) {
						Ti.API.info("processing " + JSON.stringify(e));
						var tClient = base.clientFactory();
						var tPath = base.urlHelper(tEndpoint, null, 0);
						var tParams = toQueryString(tLocal(e));
						tPath = tPath.replace(tEndpoint, tEndpoint + "/" + e.get('remote_id'));
						tClient.onload = function() {
							e.destroy({
								wait : true,
								success : function() {
									Ti.API.info("destroyed remote record " + JSON.stringify(e));
									base.trigger(aObj);
								},
								error : function() {
									Ti.API.error("unable to confirm destroy: " + JSON.stringify(e));
								}
							});
						};
						tClient.onerror = function() {
							Ti.API.error("unable to update remote record " + JSON.stringify(this.responseText));
						};
						tClient.open('DELETE', tPath, false);
						if (base.bearerToken) {
							tClient.setRequestHeader("Authorization", "Bearer " + base.bearerToken);
						}
						tClient.send();

					});
				}
			});

			Ti.API.info("finished updating " + aObj);
		};

		// Local database utility methods

		base.getNextId = function(aModel, aCallback) {
			var tModel = aModel.toLowerCase();
			var tMaxId = 1;
			var tCollection = Alloy.Collections.instance(titleize(tModel));
			tCollection.fetch({
				query : 'select local_id from ' + tModel + ' where local_id is not null order by local_id desc limit 1',
				success : function() {
					var tLastId = 0;
					if (tCollection.length > 0) {
						var tVal = tCollection.at(0).get('local_id');
						if (tVal != null && tVal != undefined && tVal > 0) {
							tLastId = tVal;
						}
					}
					aCallback(tLastId + 1);
				}
			});
		};

		base.clean = function(aCollections, aStrategy) {
			_.each(aCollections, function(e) {
				e.fetch({
					success : function() {
						var tOldObjs = e.select(aStrategy);
						_.each(tOldObjs, function(aObj) {
							aObj.destroy();
						});
						e.remove(tOldObjs);
					}
				});
			});

		};

		base.recordOutOfDate = function(aRecord) {
			var tNow = Date.now();
			var tRecordDate = new Date(aRecord.updated_at);
			var tMillis = tNow - tRecordDate;
			var tDays = tMillis / (1000 * 60 * 60 * 24);
			return tDays > 30;
		};

		// Remote API utility methods
		base.urlHelper = function(aCollection, aSince, aPage) {
			var tUrl = base.host + base.basePath + "/" + aCollection + ".json?";
			if (aSince) {
				tUrl += "where[" + aCollection + "][updated_at][gt]=" + aSince;
			}
			if (aPage > 0) {
				tUrl += "&page=" + aPage;
			}
			return tUrl;
		};

		// Private utility methods
		function deepQueryString(aObj, aKeyPath, aWrap) {
			var tResults = [];
			for (var key in aObj) {
				if (aObj.hasOwnProperty(key)) {
					var tVal = aObj[key];
					var tNextKeyPath = aWrap ? aKeyPath + "[" + key + "]" : aKeyPath + key;
					if ( typeof tVal === "object") {
						tResults.push(deepQueryString(tVal, tNextKeyPath, true));
					} else {
						tResults.push(encodeURIComponent(tNextKeyPath) + "=" + encodeURIComponent(tVal));
					}
				}
			}
			return tResults;
		}

		function queueForPush(aObj) {
			var tQueuedTimer = base.queued[aObj];
			if (tQueuedTimer == null) {
				Ti.API.info("queued " + aObj + " for push");
				tQueuedTimer = setTimeout(function() {
					base.pushUpdates(aObj);
					base.queued[aObj] = null;
				}, 100);
			}
		}

		function toQueryString(aObj) {
			return _.flatten(deepQueryString(aObj, "", false)).join("&");
		}

		function titleize(aString) {
			return aString.charAt(0).toUpperCase() + aString.slice(1);
		}

		// global on the server, window in the browser
		var root;

		root = this;

		// AMD / RequireJS
		if ( typeof define !== 'undefined' && define.amd) {
			define([], function() {
				return base;
			});
		}
		// Node.js
		else if ( typeof module !== 'undefined' && module.exports) {
			module.exports = base;
		}
		// included directly via <script> tag
		else {
			root.goldbrick = base;
		}

	}());
